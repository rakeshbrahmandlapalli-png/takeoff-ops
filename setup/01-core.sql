-- ════════════════════════════════════════════════════════════════════════
--  TAKEOFF OPS — part 1: companies, staff, day sheets, bookings, activity
--
--  Run once in the Supabase SQL editor. Safe to run again.
--
--  Built for more than one company from day one (TAKEOFF first, 247 later):
--  every row carries company_id, and row level security walls companies off
--  from each other inside the database itself.
--
--  Nobody writes to the tables directly. Every tap goes through a function
--  below that checks the person's role first, stamps who and when, and writes
--  the activity log in the same step, so the log can't be skipped or edited.
-- ════════════════════════════════════════════════════════════════════════
begin;

create extension if not exists pgcrypto with schema extensions;

-- ── COMPANIES ──────────────────────────────────────────────────────────
create table if not exists companies (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  slug          text not null unique,
  yards         text[] not null default '{}',          -- e.g. {NY,S,CP,Y,T}; SENT also sets T
  drops_day_end time not null default '06:00',         -- a DROPS sheet runs to this time next morning
  time_zone     text not null default 'Europe/London',
  brand         jsonb not null default '{}',           -- name, colour, logo for the app
  created_at    timestamptz not null default now()
);

-- ── STAFF ──────────────────────────────────────────────────────────────
-- One row per person. They sign in with a personal link plus a 4-digit PIN;
-- the link and PIN are only ever stored hashed, in staff_secrets, which no
-- signed-in user can read. user_id is the Supabase login behind the scenes.
create table if not exists staff (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  user_id     uuid unique references auth.users(id) on delete set null,
  name        text not null check (length(trim(name)) between 1 and 60),
  role        text not null check (role in ('owner','office','manager','bongo','terminal','view')),
  extra       text[] not null default '{}',             -- "flights" gives, "-flights" takes away
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create index if not exists staff_company_idx on staff(company_id);

create table if not exists staff_secrets (
  staff_id      uuid primary key references staff(id) on delete cascade,
  link_hash     text not null unique,                  -- sha256 of the personal link token
  pin_hash      text not null,                         -- bcrypt of the PIN
  failed_pins   integer not null default 0,
  locked_until  timestamptz,
  updated_at    timestamptz not null default now()
);

-- ── DAY SHEETS AND BOOKINGS ────────────────────────────────────────────
create table if not exists sheets (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id) on delete cascade,
  kind         text not null check (kind in ('drops','picks')),
  day          date not null,
  imported_by  uuid references staff(id) on delete set null,
  imported_at  timestamptz not null default now(),
  source       jsonb not null default '{}',             -- file names and counts from the import
  unique (company_id, kind, day)
);

create table if not exists bookings (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id) on delete cascade,
  sheet_id      uuid not null references sheets(id) on delete cascade,
  kind          text not null check (kind in ('drops','picks')),
  ref           text not null default '',
  reg           text not null default '',
  name          text not null default '',
  phone         text not null default '',
  make          text not null default '',
  drop_at       timestamptz,                            -- car handed to us
  return_at     timestamptz,                            -- car handed back
  flight        text not null default '',
  sched_time    text not null default '',               -- scheduled landing, HH:MM
  est_time      text not null default '',               -- live estimate / landed, HH:MM or DELAY
  flight_status text not null default '',
  flight_checked_at timestamptz,
  -- DROPS
  yard          text not null default '',
  yard_before_t text not null default '',               -- where the car was before SENT set T
  sent_at       timestamptz, sent_by uuid references staff(id) on delete set null,
  called_word   text not null default '',               -- Called / Overstay
  called_at     timestamptz, called_by uuid references staff(id) on delete set null,
  clear_word    text not null default '',               -- Collected / COMPLAINT
  cleared_at    timestamptz, cleared_by uuid references staff(id) on delete set null,
  overstay      boolean not null default false,
  -- PICKS
  intake        text not null default '',               -- Collected / No Show / RTC
  intake_at     timestamptz, intake_by uuid references staff(id) on delete set null,
  pt_at         timestamptz, pt_by uuid references staff(id) on delete set null,
  pick_called   text not null default '',               -- Called / New Booking
  pick_called_at timestamptz,
  -- both
  note          text not null default '' check (length(note) <= 500),
  updated_at    timestamptz not null default now()
);
create index if not exists bookings_sheet_idx on bookings(sheet_id);
create index if not exists bookings_company_ref_idx on bookings(company_id, kind, ref);
create index if not exists bookings_open_drops_idx on bookings(company_id) where kind = 'drops' and cleared_at is null;

-- ── ACTIVITY LOG ───────────────────────────────────────────────────────
create table if not exists activity (
  id          bigint generated always as identity primary key,
  company_id  uuid not null references companies(id) on delete cascade,
  at          timestamptz not null default now(),
  staff_id    uuid references staff(id) on delete set null,
  staff_name  text not null default '',
  sheet_id    uuid references sheets(id) on delete set null,
  booking_id  uuid references bookings(id) on delete set null,
  reg         text not null default '',
  customer    text not null default '',
  action      text not null,
  value       text not null default ''
);
create index if not exists activity_company_idx on activity(company_id, at desc);


-- ── WHO IS ASKING ──────────────────────────────────────────────────────
-- security definer so policies can call these without recursing into the
-- tables they protect. Returns nothing for anyone inactive.
create or replace function me() returns staff
language sql stable security definer set search_path = public as $$
  select * from staff where user_id = auth.uid() and active limit 1
$$;

create or replace function my_company() returns uuid
language sql stable security definer set search_path = public as $$
  select company_id from staff where user_id = auth.uid() and active limit 1
$$;

-- Which roles may do what. Anything not listed is open to every role except
-- "view". EXTRA can grant ("flights") or take away ("-flights"); a take-away wins.
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
    else null end;
  if roles is null then return s.role <> 'view'; end if;
  return s.role = any(roles);
end;
$$;

-- What the app may show this person, so it never draws a button that bounces.
create or replace function my_permissions() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_object_agg(a, can(a)) from unnest(array['sent','called','clear','yard','summary','log','flights','rtc','picksinfo','import','staff','note','intake']) a
$$;

create or replace function log_activity(p_booking bookings, p_action text, p_value text)
returns void language plpgsql security definer set search_path = public as $$
declare s staff := me();
begin
  insert into activity(company_id, staff_id, staff_name, sheet_id, booking_id, reg, customer, action, value)
  values (p_booking.company_id, s.id, coalesce(s.name, ''), p_booking.sheet_id, p_booking.id,
          p_booking.reg, p_booking.name, p_action, coalesce(p_value, ''));
end;
$$;

-- Loads one booking of the caller's company, locked for the change.
create or replace function booking_for_update(p_id uuid) returns bookings
language plpgsql security definer set search_path = public as $$
declare b bookings;
begin
  select * into b from bookings where id = p_id and company_id = my_company() for update;
  if not found then raise exception 'That car is not on your board.'; end if;
  return b;
end;
$$;


-- ── DROPS TAPS: SENT / CALLED / CLEAR ──────────────────────────────────
create or replace function tap_drop(p_booking uuid, p_action text, p_on boolean, p_word text default '')
returns bookings language plpgsql security definer set search_path = public as $$
declare
  b bookings := booking_for_update(p_booking);
  s staff := me();
  w text := coalesce(nullif(trim(p_word), ''), '');
begin
  if b.kind <> 'drops' then raise exception 'That is a PICKS car.'; end if;
  if p_action not in ('sent','called','clear') then raise exception 'Unknown action: %', p_action; end if;
  if not can(p_action) then raise exception 'Not allowed for your role (%): %', s.role, p_action; end if;

  if p_action = 'sent' then
    if p_on and b.sent_at is null then
      b.yard_before_t := b.yard; b.yard := 'T'; b.sent_at := now(); b.sent_by := s.id;
    elsif not p_on then
      if b.yard = 'T' and b.yard_before_t <> '' then b.yard := b.yard_before_t; end if;
      b.yard_before_t := ''; b.sent_at := null; b.sent_by := null;
    end if;
  elsif p_action = 'called' then
    if p_on then
      if w = '' then w := 'Called'; end if;
      if w not in ('Called','Overstay') then raise exception 'Not a valid option: %', w; end if;
      b.called_word := w; b.called_at := now(); b.called_by := s.id;
      b.overstay := b.overstay or w = 'Overstay';
    else
      b.called_word := ''; b.called_at := null; b.called_by := null;
    end if;
  else
    if p_on then
      if w = '' then w := 'Collected'; end if;
      if w not in ('Collected','COMPLAINT') then raise exception 'Not a valid option: %', w; end if;
      b.clear_word := w; b.cleared_at := now(); b.cleared_by := s.id;
    else
      b.clear_word := ''; b.cleared_at := null; b.cleared_by := null;
    end if;
  end if;

  b.updated_at := now();
  update bookings set yard = b.yard, yard_before_t = b.yard_before_t, sent_at = b.sent_at, sent_by = b.sent_by,
    called_word = b.called_word, called_at = b.called_at, called_by = b.called_by, overstay = b.overstay,
    clear_word = b.clear_word, cleared_at = b.cleared_at, cleared_by = b.cleared_by, updated_at = b.updated_at
  where id = b.id;
  perform log_activity(b, upper(p_action), case when p_on then coalesce(nullif(w, ''), upper(p_action)) else '(cleared)' end);
  return b;
end;
$$;

-- ── YARD, NOTE ─────────────────────────────────────────────────────────
create or replace function set_yard(p_booking uuid, p_yard text)
returns bookings language plpgsql security definer set search_path = public as $$
declare
  b bookings := booking_for_update(p_booking);
  y text := upper(trim(coalesce(p_yard, '')));
  yards text[];
begin
  if not can('yard') then raise exception 'Not allowed for your role: yard'; end if;
  select c.yards into yards from companies c where c.id = b.company_id;
  if y <> '' and not (y = any(yards)) then raise exception 'Not a valid yard: %', y; end if;
  -- The office's choice always wins, including T for cars left at the
  -- terminal. Forget the pre-SENT yard so undoing SENT can't overwrite it.
  update bookings set yard = y, yard_before_t = '', updated_at = now() where id = b.id returning * into b;
  perform log_activity(b, 'YARD', coalesce(nullif(y, ''), '(cleared)'));
  return b;
end;
$$;

create or replace function set_note(p_booking uuid, p_note text)
returns bookings language plpgsql security definer set search_path = public as $$
declare
  b bookings := booking_for_update(p_booking);
  n text := trim(coalesce(p_note, ''));
begin
  if not can('note') then raise exception 'Not allowed for your role: note'; end if;
  if length(n) > 500 then raise exception 'Notes can be up to 500 characters.'; end if;
  if n = b.note then return b; end if;
  update bookings set note = n, updated_at = now() where id = b.id returning * into b;
  perform log_activity(b, 'NOTE', coalesce(nullif(n, ''), '(cleared)'));
  return b;
end;
$$;

-- ── PICKS TAPS: IN / NO SHOW / RTC, PHOTOS, CALLED ─────────────────────
create or replace function tap_pick(p_booking uuid, p_key text, p_value text)
returns bookings language plpgsql security definer set search_path = public as $$
declare
  b bookings := booking_for_update(p_booking);
  s staff := me();
  v text := trim(coalesce(p_value, ''));
begin
  if b.kind <> 'picks' then raise exception 'That is a DROPS car.'; end if;
  if not can('intake') then raise exception 'Not allowed for your role: %', s.role; end if;
  if p_key = 'intake' then
    if v <> '' and v not in ('Collected','No Show','RTC') then raise exception 'Not a valid option: %', v; end if;
    if v = 'RTC' and not can('rtc') then raise exception 'Not allowed for your role (%): RTC', s.role; end if;
    update bookings set intake = v, intake_at = case when v = '' then null else now() end,
      intake_by = case when v = '' then null else s.id end, updated_at = now() where id = b.id returning * into b;
  elsif p_key = 'pt' then
    update bookings set pt_at = case when v = '' then null else now() end,
      pt_by = case when v = '' then null else s.id end, updated_at = now() where id = b.id returning * into b;
  elsif p_key = 'called' then
    if v <> '' and v not in ('Called','New Booking') then raise exception 'Not a valid option: %', v; end if;
    update bookings set pick_called = v, pick_called_at = case when v = '' then null else now() end,
      updated_at = now() where id = b.id returning * into b;
  else
    raise exception 'Unknown action: %', p_key;
  end if;
  perform log_activity(b, upper(p_key), coalesce(nullif(v, ''), '(cleared)'));
  return b;
end;
$$;


-- ── IMPORT A DAY ───────────────────────────────────────────────────────
-- p_rows: [{ref, reg, name, phone, make, drop_local, return_local, flight, note}]
-- with times as local "YYYY-MM-DD HH:MM". Importing the same day again keeps
-- everything the team has already done (taps, yards, notes) and only refreshes
-- the booking details; new bookings are added. (Overstays are moved by
-- carry_overstays() when the new shift starts, NOT here: the office often
-- imports tomorrow the evening before, while today's cars are still out.)
create or replace function import_sheet(p_kind text, p_day date, p_rows jsonb, p_source jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s staff := me();
  c companies;
  sh sheets;
  r jsonb;
  added int := 0; updated int := 0;
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

  for r in select * from jsonb_array_elements(p_rows) loop
    select * into existing from bookings
      where company_id = c.id and sheet_id = sh.id and ref <> '' and ref = coalesce(r->>'ref', '') limit 1;
    if found then
      update bookings set
        reg = coalesce(r->>'reg', reg), name = coalesce(r->>'name', name), phone = coalesce(r->>'phone', phone),
        make = coalesce(r->>'make', make),
        drop_at = coalesce(nullif(r->>'drop_local', '')::timestamp at time zone c.time_zone, drop_at),
        return_at = coalesce(nullif(r->>'return_local', '')::timestamp at time zone c.time_zone, return_at),
        flight = case when coalesce(r->>'flight', '') <> '' then r->>'flight' else flight end,
        note = case when note = '' then coalesce(r->>'note', '') else note end,
        updated_at = now()
      where id = existing.id;
      updated := updated + 1;
    else
      insert into bookings(company_id, sheet_id, kind, ref, reg, name, phone, make, drop_at, return_at, flight, note)
      values (c.id, sh.id, p_kind, coalesce(r->>'ref', ''), coalesce(r->>'reg', ''), coalesce(r->>'name', ''),
        coalesce(r->>'phone', ''), coalesce(r->>'make', ''),
        nullif(r->>'drop_local', '')::timestamp at time zone c.time_zone,
        nullif(r->>'return_local', '')::timestamp at time zone c.time_zone,
        coalesce(r->>'flight', ''), left(coalesce(r->>'note', ''), 500));
      added := added + 1;
    end if;
  end loop;

  insert into activity(company_id, staff_id, staff_name, sheet_id, action, value)
  values (c.id, s.id, s.name, sh.id, 'IMPORT', p_kind || ' ' || p_day || ': ' || added || ' added, ' || updated || ' updated');

  return jsonb_build_object('sheet_id', sh.id, 'added', added, 'updated', updated);
end;
$$;


-- ── OVERSTAYS ──────────────────────────────────────────────────────────
-- Once a DROPS shift has started, any car from an earlier DROPS sheet that was
-- never cleared moves onto the current sheet, marked overstay, keeping every
-- tap and note. Run by a timer at each company's day-end time (part 3), and
-- safe to run any time: before the shift starts it does nothing.
create or replace function carry_overstays(p_company uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  c companies;
  local_now timestamp;
  shift_day date;
  target sheets;
  moved integer;
begin
  select * into c from companies where id = p_company;
  if not found then return 0; end if;
  local_now := now() at time zone c.time_zone;
  shift_day := case when local_now::time <= c.drops_day_end then local_now::date - 1 else local_now::date end;
  select * into target from sheets where company_id = c.id and kind = 'drops' and day = shift_day;
  if not found then return 0; end if;
  update bookings b set sheet_id = target.id, overstay = true, updated_at = now()
  from sheets old
  where b.sheet_id = old.id and old.company_id = c.id and old.kind = 'drops'
    and old.day < shift_day and old.day >= shift_day - 14 and b.cleared_at is null;
  get diagnostics moved = row_count;
  if moved > 0 then
    insert into activity(company_id, staff_name, sheet_id, action, value)
    values (c.id, 'System', target.id, 'OVERSTAYS', moved || ' car(s) carried to ' || shift_day);
  end if;
  return moved;
end;
$$;

-- ── ROW LEVEL SECURITY ─────────────────────────────────────────────────
alter table companies     enable row level security;
alter table staff         enable row level security;
alter table staff_secrets enable row level security;
alter table sheets        enable row level security;
alter table bookings      enable row level security;
alter table activity      enable row level security;

drop policy if exists companies_read on companies;
create policy companies_read on companies for select to authenticated using (id = my_company());

drop policy if exists staff_read on staff;
create policy staff_read on staff for select to authenticated using (company_id = my_company());

drop policy if exists sheets_read on sheets;
create policy sheets_read on sheets for select to authenticated using (company_id = my_company());

drop policy if exists bookings_read on bookings;
create policy bookings_read on bookings for select to authenticated using (company_id = my_company());

drop policy if exists activity_read on activity;
create policy activity_read on activity for select to authenticated using (company_id = my_company() and can('log'));

-- Reads only; every write goes through the functions above.
revoke all on table companies, staff, staff_secrets, sheets, bookings, activity from anon, authenticated;
grant select on table companies, staff, sheets, bookings, activity to authenticated;

revoke execute on all functions in schema public from public, anon;
grant execute on function me(), my_company(), can(text), my_permissions(),
  tap_drop(uuid, text, boolean, text), set_yard(uuid, text), set_note(uuid, text),
  tap_pick(uuid, text, text), import_sheet(text, date, jsonb, jsonb) to authenticated;
revoke execute on function log_activity(bookings, text, text), booking_for_update(uuid), carry_overstays(uuid) from authenticated;

-- Live updates: every phone hears changes to bookings the moment they happen.
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'bookings') then
    alter publication supabase_realtime add table bookings;
  end if;
end $$;

-- ── TAKEOFF ────────────────────────────────────────────────────────────
insert into companies (name, slug, yards, brand)
values ('TAKEOFF', 'takeoff', array['NY','S','CP','Y','T'], '{"colour":"#F9A01B","name":"TakeOff"}')
on conflict (slug) do update set yards = excluded.yards;

commit;
