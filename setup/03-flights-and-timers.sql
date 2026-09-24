-- ════════════════════════════════════════════════════════════════════════
--  TAKEOFF OPS — part 3: flight times and timers
--
--  Run after parts 1 and 2. Safe to run again.
--
--  Adds:
--    • the columns the flight checks fill in (timetable time, live estimate)
--    • flight_runs: a short record of every check, so "is it working?" has
--      an answer on the Flights screen
--    • set_flight: the office corrects a flight number on a car
--    • two timers (pg_cron):
--        every 15 min  carry_overstays for every company (does nothing until
--                      the shift has started, and nothing twice)
--        every 10 min  wakes the "flights" Edge Function, which decides for
--                      itself whether a check is due, so the credit rules
--                      live in one place
--    • day sheets in the live feed, so a new import shows on every phone
--
--  The flight keys (FR24_TOKEN, AERODATABOX_KEY) are NOT in here: they go in
--  Edge Functions → Secrets, where no phone can read them.
-- ════════════════════════════════════════════════════════════════════════
begin;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- ── WHERE EACH COMPANY'S FLIGHTS LAND ──────────────────────────────────
-- Both codes: the live feed answers in IATA, some records carry only ICAO.
alter table companies add column if not exists airport_iata text not null default 'LTN';
alter table companies add column if not exists airport_icao text not null default 'EGGW';

-- ── FLIGHT FIELDS ON A BOOKING ─────────────────────────────────────────
-- sched_time / est_time (HH:MM text) stay as what the board shows; these are
-- the real moments behind them, so a 00:40 landing is never mistaken for
-- this afternoon's.
--   flight_status: ''         nothing known yet
--                  scheduled  timetable time found
--                  expected   airline has moved it later, not airborne yet
--                  airborne   FR24 has the aircraft and an ETA
--                  delayed    due within the hour and not in the air
--                  landed     on the ground
--                  cancelled  airline scrapped it
alter table bookings add column if not exists sched_at timestamptz;
alter table bookings add column if not exists est_at timestamptz;
alter table bookings add column if not exists flight_note text not null default '';

create table if not exists flight_runs (
  id          bigint generated always as identity primary key,
  company_id  uuid not null references companies(id) on delete cascade,
  at          timestamptz not null default now(),
  source      text not null check (source in ('schedule','live')),
  trigger     text not null check (trigger in ('timer','button')),
  result      jsonb not null default '{}'
);
create index if not exists flight_runs_company_idx on flight_runs(company_id, source, at desc);

alter table flight_runs enable row level security;
drop policy if exists flight_runs_read on flight_runs;
create policy flight_runs_read on flight_runs for select to authenticated using (company_id = my_company());
revoke all on table flight_runs from anon, authenticated;
grant select on table flight_runs to authenticated;

-- ── JOB NUMBERS ────────────────────────────────────────────────────────
-- "#12" on the board: the car's place on its day sheet, in the order the
-- import listed them (landing time for DROPS, drop-off for PICKS), exactly
-- like the row numbers the team used on the Sheet. A re-import keeps every
-- number and gives new bookings the next ones.
alter table bookings add column if not exists num integer;
update bookings b set num = x.n
from (select id, row_number() over (partition by sheet_id order by coalesce(case when kind = 'picks' then drop_at else return_at end, updated_at), ref) n
      from bookings) x
where b.id = x.id and b.num is null;

create or replace function import_sheet(p_kind text, p_day date, p_rows jsonb, p_source jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s staff := me();
  c companies;
  sh sheets;
  r jsonb;
  added int := 0; updated int := 0;
  next_num int;
  existing bookings;
begin
  if not can('import') then raise exception 'Not allowed for your role: import'; end if;
  if p_kind not in ('drops','picks') then raise exception 'Unknown sheet type: %', p_kind; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 1000 then raise exception 'Nothing to import.'; end if;
  select * into c from companies where id = s.company_id;

  insert into sheets(company_id, kind, day, imported_by, source)
  values (c.id, p_kind, p_day, s.id, coalesce(p_source, '{}'))
  on conflict (company_id, kind, day) do update set imported_by = excluded.imported_by, imported_at = now(), source = excluded.source
  returning * into sh;
  select coalesce(max(num), 0) into next_num from bookings where sheet_id = sh.id;

  for r in select * from jsonb_array_elements(p_rows) loop
    select * into existing from bookings
      where company_id = c.id and sheet_id = sh.id and ref <> '' and ref = coalesce(r->>'ref', '') limit 1;
    if found then
      -- A changed flight number forgets the times found for the old one.
      update bookings set
        reg = coalesce(r->>'reg', reg), name = coalesce(r->>'name', name), phone = coalesce(r->>'phone', phone),
        make = coalesce(r->>'make', make),
        drop_at = coalesce(nullif(r->>'drop_local', '')::timestamp at time zone c.time_zone, drop_at),
        return_at = coalesce(nullif(r->>'return_local', '')::timestamp at time zone c.time_zone, return_at),
        sched_at = case when coalesce(r->>'flight', '') not in ('', flight) then null else sched_at end,
        sched_time = case when coalesce(r->>'flight', '') not in ('', flight) then '' else sched_time end,
        est_at = case when coalesce(r->>'flight', '') not in ('', flight) then null else est_at end,
        est_time = case when coalesce(r->>'flight', '') not in ('', flight) then '' else est_time end,
        flight_status = case when coalesce(r->>'flight', '') not in ('', flight) then '' else flight_status end,
        flight_note = case when coalesce(r->>'flight', '') not in ('', flight) then '' else flight_note end,
        flight = case when coalesce(r->>'flight', '') <> '' then r->>'flight' else flight end,
        note = case when note = '' then coalesce(r->>'note', '') else note end,
        num = coalesce(num, next_num + 1),
        updated_at = now()
      where id = existing.id;
      if existing.num is null then next_num := next_num + 1; end if;
      updated := updated + 1;
    else
      next_num := next_num + 1;
      insert into bookings(company_id, sheet_id, kind, ref, reg, name, phone, make, drop_at, return_at, flight, note, num)
      values (c.id, sh.id, p_kind, coalesce(r->>'ref', ''), coalesce(r->>'reg', ''), coalesce(r->>'name', ''),
        coalesce(r->>'phone', ''), coalesce(r->>'make', ''),
        nullif(r->>'drop_local', '')::timestamp at time zone c.time_zone,
        nullif(r->>'return_local', '')::timestamp at time zone c.time_zone,
        coalesce(r->>'flight', ''), left(coalesce(r->>'note', ''), 500), next_num);
      added := added + 1;
    end if;
  end loop;

  insert into activity(company_id, staff_id, staff_name, sheet_id, action, value)
  values (c.id, s.id, s.name, sh.id, 'IMPORT', p_kind || ' ' || p_day || ': ' || added || ' added, ' || updated || ' updated');

  return jsonb_build_object('sheet_id', sh.id, 'added', added, 'updated', updated);
end;
$$;
revoke execute on function import_sheet(text, date, jsonb, jsonb) from public, anon;
grant execute on function import_sheet(text, date, jsonb, jsonb) to authenticated;

-- ── FLIGHT CHECK SETTINGS (owner and manager, in the app) ──────────────
-- Anything missing falls back to the defaults the Sheet ran on.
alter table companies add column if not exists flight_settings jsonb not null default '{}';

-- Same rules as part 1, plus "settings": owner and manager only.
create or replace function can(p_action text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  s staff := me();
  roles text[];
begin
  if s.id is null then return false; end if;
  if ('-' || p_action) = any(s.extra) then return false; end if;
  if p_action = any(s.extra) then return true; end if;
  if s.role = 'owner' then return true; end if;
  roles := case p_action
    when 'sent'      then array['office','manager','bongo']
    when 'called'    then array['office','manager']
    when 'clear'     then array['office','manager','terminal']
    when 'yard'      then array['office','manager']
    when 'summary'   then array['office','manager']
    when 'log'       then array['office','manager']
    when 'flights'   then array['office']
    when 'rtc'       then array['office','manager','bongo']
    when 'picksinfo' then array['office','manager','terminal']
    when 'import'    then array['office','manager']
    when 'staff'     then array['office','manager']
    when 'settings'  then array['manager']
    else null end;
  if roles is null then return s.role <> 'view'; end if;
  return s.role = any(roles);
end;
$$;

create or replace function my_permissions() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_object_agg(a, can(a)) from unnest(array['sent','called','clear','yard','summary','log','flights','rtc','picksinfo','import','staff','note','intake','settings']) a
$$;

create or replace function set_flight_settings(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s staff := me();
  live int := coalesce((p->>'live_every_min')::int, 30);
  sched int := coalesce((p->>'schedule_every_hours')::int, 2);
  f int := coalesce((p->>'active_from')::int, 6);
  t int := coalesce((p->>'active_to')::int, 24);
  before int := coalesce((p->>'before_min')::int, 90);
  after int := coalesce((p->>'after_hours')::int, 5);
  on_ boolean := coalesce((p->>'enabled')::boolean, true);
  v jsonb;
begin
  if not can('settings') then raise exception 'Only an owner or manager can change settings.'; end if;
  -- The timer wakes every 10 minutes, so nothing can run more often than that.
  if live not in (10,15,20,30,45,60,90,120) then raise exception 'Live check: choose 10 min to 2 hours.'; end if;
  if sched not in (1,2,3,4,6,12) then raise exception 'Timetable check: choose 1 to 12 hours.'; end if;
  if f < 0 or f > 23 or t < 1 or t > 24 or f = t then raise exception 'Check the start and end hours.'; end if;
  if before not in (30,60,90,120,180,240) then raise exception 'Start watching: choose 30 min to 4 hours before.'; end if;
  if after not in (1,2,3,4,5,6) then raise exception 'Stop watching: choose 1 to 6 hours after.'; end if;
  v := jsonb_build_object('enabled', on_, 'live_every_min', live, 'schedule_every_hours', sched,
    'active_from', f, 'active_to', t, 'before_min', before, 'after_hours', after);
  update companies set flight_settings = v where id = s.company_id;
  insert into activity(company_id, staff_id, staff_name, action, value)
  values (s.company_id, s.id, s.name, 'SETTINGS',
    case when on_ then 'Flight checks: live every ' || live || ' min, ' || lpad(f::text, 2, '0') || ':00–' || lpad(t::text, 2, '0') || ':00, from '
      || before || ' min before to ' || after || ' h after; timetable every ' || sched || ' h'
    else 'Flight checks switched OFF' end);
  return v;
end;
$$;
revoke execute on function set_flight_settings(jsonb) from public, anon;
grant execute on function set_flight_settings(jsonb) to authenticated;

-- ── THE OFFICE CORRECTS A FLIGHT NUMBER ────────────────────────────────
-- A new number forgets every time found for the old one; the next check
-- looks the new one up.
create or replace function set_flight(p_booking uuid, p_flight text)
returns bookings language plpgsql security definer set search_path = public as $$
declare
  b bookings := booking_for_update(p_booking);
  f text := upper(regexp_replace(coalesce(p_flight, ''), '[^A-Za-z0-9]', '', 'g'));
begin
  if not can('flights') then raise exception 'Not allowed for your role: flights'; end if;
  if b.kind <> 'drops' then raise exception 'Flights are on DROPS cars.'; end if;
  if length(f) > 10 then raise exception 'That does not look like a flight number.'; end if;
  if f = b.flight then return b; end if;
  update bookings set flight = f, sched_at = null, sched_time = '', est_at = null, est_time = '',
    flight_status = '', flight_note = '', flight_checked_at = null, updated_at = now()
  where id = b.id returning * into b;
  perform log_activity(b, 'FLIGHT', coalesce(nullif(f, ''), '(cleared)'));
  return b;
end;
$$;
revoke execute on function set_flight(uuid, text) from public, anon;
grant execute on function set_flight(uuid, text) to authenticated;

-- ── TIMER KEY ──────────────────────────────────────────────────────────
-- A random value made here, never typed by anyone. The timer sends it; the
-- flights function asks the database whether it matches. Kept outside the
-- public schema, so no phone can read it.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table if not exists private.settings (name text primary key, value text not null);
insert into private.settings(name, value)
values ('timer_secret', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (name) do nothing;

create or replace function timer_secret_ok(p_secret text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from private.settings where name = 'timer_secret' and value = p_secret and length(p_secret) >= 32)
$$;
revoke execute on function timer_secret_ok(text) from public, anon, authenticated;
grant execute on function timer_secret_ok(text) to service_role;

-- ── TIMERS ─────────────────────────────────────────────────────────────
-- Scheduling a job under a name that already exists replaces it.
select cron.schedule('takeoff-overstays', '*/15 * * * *',
  $job$ select carry_overstays(id) from public.companies $job$);

select cron.schedule('takeoff-flights', '*/10 * * * *', $job$
  select net.http_post(
    url := 'https://oioqjfrlwrjovnouhusp.supabase.co/functions/v1/flights',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-timer', (select value from private.settings where name = 'timer_secret')),
    body := '{"action":"timer"}'::jsonb,
    timeout_milliseconds := 120000)
$job$);

-- ── LIVE FEED ──────────────────────────────────────────────────────────
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'sheets') then
    alter publication supabase_realtime add table sheets;
  end if;
end $$;

commit;
