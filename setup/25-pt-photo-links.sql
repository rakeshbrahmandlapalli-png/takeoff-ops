-- Parking Ops — database part 25: PT photos as one link.
--
-- The driver picks the photos from the phone's own camera roll (full quality),
-- the app uploads them here, and WhatsApp opens once with the reg and a link.
-- PT opens the link to see every photo full size and download them. No
-- batches of 10, and WhatsApp never shrinks the photos.
--
--   • bucket pt-photos (private): <company>/<booking>/<link token>/<n>.jpg
--     Staff who can tap PT upload into their own company's folder only.
--   • pt_links: which photos a link shows. Nobody reads it directly: the
--     pt-photos Edge Function looks a link up and hands out signed URLs.
--   • links and their photos are deleted after 30 days (nightly timer).
--
-- After running this, deploy supabase/functions/pt-photos ("Verify JWT" OFF).
-- Safe to run twice.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pt-photos', 'pt-photos', false, 26214400, array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists pt_photos_upload on storage.objects;
create policy pt_photos_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'pt-photos' and (storage.foldername(name))[1] = my_company()::text and can('intake'));

create table if not exists pt_links (
  token       text primary key check (token ~ '^[A-Za-z0-9_-]{22,64}$'),
  company_id  uuid not null references companies(id) on delete cascade,
  booking_id  uuid references bookings(id) on delete set null,
  reg         text not null default '',
  paths       text[] not null default '{}',
  created_by  uuid references staff(id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '30 days'
);
alter table pt_links enable row level security;   -- no policies: functions only
revoke all on pt_links from anon, authenticated;

-- The app picks the token (random, 18+ bytes) before uploading so the photos
-- can go straight into the link's folder; calling again adds to the same link.
create or replace function pt_link_save(p_token text, p_booking uuid, p_paths text[])
returns text language plpgsql security definer set search_path = public as $$
declare
  s staff := me();
  b bookings;
  prefix text;
  l pt_links;
begin
  if not can('intake') then raise exception 'Not allowed for your role: %', s.role; end if;
  select * into b from bookings where id = p_booking and company_id = s.company_id;
  if b.id is null then raise exception 'That car is not on your board.'; end if;
  if p_token !~ '^[A-Za-z0-9_-]{22,64}$' then raise exception 'Bad link.'; end if;
  prefix := s.company_id::text || '/' || b.id::text || '/' || p_token || '/';
  if exists (select 1 from unnest(coalesce(p_paths, '{}')) p where left(p, length(prefix)) <> prefix or p like '%..%') then
    raise exception 'Those photos are not in this link''s folder.';
  end if;
  select * into l from pt_links where token = p_token;
  if l.token is not null and (l.company_id <> s.company_id or l.booking_id is distinct from b.id) then raise exception 'Bad link.'; end if;
  insert into pt_links(token, company_id, booking_id, reg, paths, created_by)
  values (p_token, s.company_id, b.id, b.reg, coalesce(p_paths, '{}'), s.id)
  on conflict (token) do update
    set paths = (select array_agg(distinct x order by x) from unnest(pt_links.paths || excluded.paths) x);
  insert into activity(company_id, staff_id, staff_name, sheet_id, booking_id, reg, customer, action, value)
  values (s.company_id, s.id, s.name, b.sheet_id, b.id, b.reg, b.name, 'PT PHOTOS', cardinality(coalesce(p_paths, '{}')) || ' photos uploaded');
  return p_token;
end;
$$;
revoke execute on function pt_link_save(text, uuid, text[]) from public, anon;
grant execute on function pt_link_save(text, uuid, text[]) to authenticated;

-- For the Edge Function only.
create or replace function pt_link_view(p_token text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('reg', l.reg, 'paths', to_jsonb(l.paths), 'created_at', l.created_at, 'expires_at', l.expires_at,
                            'company', c.name, 'by', coalesce(st.name, ''))
  from pt_links l join companies c on c.id = l.company_id left join staff st on st.id = l.created_by
  where l.token = p_token and l.expires_at > now()
$$;
revoke execute on function pt_link_view(text) from public, anon, authenticated;
grant execute on function pt_link_view(text) to service_role;

create or replace function pt_links_expired()
returns table (token text, paths text[]) language sql stable security definer set search_path = public as $$
  select token, paths from pt_links where expires_at <= now() order by expires_at limit 200
$$;
create or replace function pt_link_forget(p_token text)
returns void language sql security definer set search_path = public as $$
  delete from pt_links where token = p_token
$$;
revoke execute on function pt_links_expired(), pt_link_forget(text) from public, anon, authenticated;
grant execute on function pt_links_expired(), pt_link_forget(text) to service_role;

-- Nightly: delete links older than 30 days, and their photos.
select cron.schedule('pt-photos-cleanup', '40 3 * * *', $job$
  select net.http_post(
    url := 'https://oioqjfrlwrjovnouhusp.supabase.co/functions/v1/pt-photos',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-timer', (select value from private.settings where name = 'timer_secret')),
    body := '{"action":"cleanup"}'::jsonb,
    timeout_milliseconds := 120000)
$job$);
