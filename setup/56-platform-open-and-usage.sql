-- Parking Ops — database part 56: the product owner can open a client's app,
-- and sees what each client uses.
--
-- Opening a client: the manage-staff function (action "client_open") signs
-- the product owner in as their own owner login inside that client, named
-- "<name> (Parking Ops)". It's made the first time and shows in the client's
-- Staff screen like anyone else, and their activity log shows it by that
-- name. platform_staff links it back to the product owner's login.
--
-- Usage: counts only, per client, for the last 30 days, plus the size of the
-- database and the photo store. Download traffic (egress) is only on the
-- Supabase usage page. Safe to run twice.

alter table staff add column if not exists platform_staff uuid references staff(id) on delete set null;
create unique index if not exists staff_platform_once on staff (company_id, platform_staff) where platform_staff is not null;

create or replace function admin_usage() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_platform_admin() then raise exception 'Not allowed.'; end if;
  return jsonb_build_object(
    'db_bytes', pg_database_size(current_database()),
    'store_bytes', (select coalesce(sum((o.metadata->>'size')::bigint), 0) from storage.objects o),
    'store_files', (select count(*) from storage.objects),
    'clients', coalesce((select jsonb_agg(x order by x->>'name') from (
      select jsonb_build_object(
        'id', c.id, 'name', c.name,
        'cars_30d', (select count(*) from bookings b join sheets sh on sh.id = b.sheet_id where b.company_id = c.id and sh.day >= current_date - 30 and b.removed_at is null),
        'sheets_30d', (select count(*) from sheets sh where sh.company_id = c.id and sh.day >= current_date - 30),
        'pt_sets_30d', (select count(*) from pt_links l where l.company_id = c.id and l.created_at >= now() - interval '30 days'),
        'pt_photos_30d', (select coalesce(sum(cardinality(l.paths)), 0) from pt_links l where l.company_id = c.id and l.created_at >= now() - interval '30 days'),
        'fr24_calls_30d', (select coalesce(sum(coalesce((r.result->>'calls')::int, 0)), 0) from flight_runs r where r.company_id = c.id and r.source = 'live' and r.at >= now() - interval '30 days'),
        'fr24_calls_today', (select coalesce(sum(coalesce((r.result->>'calls')::int, 0)), 0) from flight_runs r where r.company_id = c.id and r.source = 'live' and r.at >= date_trunc('day', now() at time zone 'Europe/London') at time zone 'Europe/London'),
        'timetable_runs_30d', (select count(*) from flight_runs r where r.company_id = c.id and r.source = 'schedule' and r.at >= now() - interval '30 days'),
        'timetable_last_ok', (select max(r.at) from flight_runs r where r.company_id = c.id and r.source = 'schedule' and coalesce(r.result->>'error', '') = ''),
        'timetable_last_error', (select r.result->>'error' from flight_runs r where r.company_id = c.id and r.source = 'schedule' order by r.at desc limit 1),
        'activity_30d', (select count(*) from activity a where a.company_id = c.id and a.at >= now() - interval '30 days')
      ) x from companies c where c.slug <> 'platform') t), '[]'::jsonb)
  );
end;
$$;
revoke execute on function admin_usage() from public, anon;
grant execute on function admin_usage() to authenticated;
