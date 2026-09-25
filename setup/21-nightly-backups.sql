-- Parking Ops — database part 21: nightly backups, and an owner's own download.
--
-- The free Supabase tier keeps no backups. Two layers:
--
--   1. Every night at 03:15 (UTC) each client's whole company is copied into
--      private.backups with export_company() (part 10), and the last 14 nights
--      are kept. This covers mistakes: a wiped sheet, a bad import, a wrong
--      delete. It does NOT cover losing the whole project, because it lives
--      inside it. Restore with import_company() (part 10) - ask before doing so.
--
--   2. download_my_company() lets a company's OWNER download their own data
--      from Settings, to keep a copy outside Supabase (and to prove they are
--      not locked in). Sign-in secrets and Discord links are left out of it.
--
-- Safe to run twice.

create table if not exists private.backups (
  id          bigint generated always as identity primary key,
  company_id  uuid not null references public.companies(id) on delete cascade,
  taken_at    timestamptz not null default now(),
  bookings    integer not null default 0,
  bytes       integer not null default 0,
  data        jsonb not null
);
create index if not exists backups_company_idx on private.backups(company_id, taken_at desc);

create or replace function take_backups()
returns integer language plpgsql security definer set search_path = public as $$
declare c companies; d jsonb; n integer := 0;
begin
  for c in select * from companies where slug <> 'platform' loop
    d := export_company(c.slug);
    insert into private.backups(company_id, bookings, bytes, data)
    values (c.id, jsonb_array_length(d->'bookings'), octet_length(d::text), d);
    n := n + 1;
    -- keep the newest 14 per company
    delete from private.backups b where b.company_id = c.id and b.id not in
      (select id from private.backups where company_id = c.id order by taken_at desc limit 14);
  end loop;
  return n;
end $$;
revoke execute on function take_backups() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'parking-ops-backups';
select cron.schedule('parking-ops-backups', '15 3 * * *', $job$ select public.take_backups() $job$);

-- Owner only, their own company only. No secrets.
create or replace function download_my_company()
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff := me(); c companies; d jsonb;
begin
  if s.id is null or s.role <> 'owner' then raise exception 'Only the owner can download the company''s data.'; end if;
  select * into c from companies where id = s.company_id;
  if c.slug = 'platform' then raise exception 'Nothing to download here.'; end if;
  d := export_company(c.slug) - 'staff_secrets' - 'discord';
  d := jsonb_set(d, '{staff}', coalesce((select jsonb_agg(x - 'user_id') from jsonb_array_elements(d->'staff') x), '[]'::jsonb));
  insert into activity(company_id, staff_id, staff_name, action, value)
  values (c.id, s.id, s.name, 'SETTINGS', 'Downloaded a backup of the company''s data');
  return d;
end $$;
revoke execute on function download_my_company() from public, anon;
grant execute on function download_my_company() to authenticated;

-- First copy now, so there is one before tonight.
select take_backups();
