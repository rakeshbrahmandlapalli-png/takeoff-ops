-- Parking Ops — database part 29: early returns.
--
-- A customer booked back tomorrow rings tonight to come back early. EARLY
-- RETURN moves the car from its booked DROPS sheet onto tonight's (the shift
-- running now), marked EARLY, so tonight's team sees it in the queue. The
-- booked return time is kept, so it's clear when they were due.
--   • Undo puts it back on the sheet it came from.
--   • Importing the booked day's sheet again leaves it where it is, not a
--     second copy (import_sheet skips a ref moved off that sheet).
--   • An early return that doesn't come tonight is carried on at 06:00 like any
--     car, but not marked OVERSTAY while it's still before its booked day; once
--     it's on its booked day it's an ordinary car again.
-- Safe to run twice.

alter table bookings add column if not exists early boolean not null default false;
alter table bookings add column if not exists early_at timestamptz;
alter table bookings add column if not exists moved_from uuid references sheets(id) on delete set null;
create index if not exists bookings_moved_from_idx on bookings(moved_from) where moved_from is not null;

create or replace function early_return(p_booking uuid)
returns bookings language plpgsql security definer set search_path = public as $$
declare
  s staff := me();
  c companies;
  b bookings;
  src sheets;
  target sheets;
  shift_day date;
  n int;
begin
  if not can('called') then raise exception 'Not allowed for your role: %', s.role; end if;
  select * into c from companies where id = s.company_id;
  select * into b from bookings where id = p_booking and company_id = c.id and kind = 'drops' for update;
  if b.id is null then raise exception 'That car is not on your DROPS board.'; end if;
  if b.cleared_at is not null then raise exception 'That car has already gone.'; end if;
  select * into src from sheets where id = b.sheet_id;
  shift_day := case when (now() at time zone c.time_zone)::time <= c.drops_day_end
                    then (now() at time zone c.time_zone)::date - 1 else (now() at time zone c.time_zone)::date end;
  if src.day <= shift_day then raise exception 'This car is already on tonight''s sheet or an earlier one.'; end if;
  select * into target from sheets where company_id = c.id and kind = 'drops' and day = shift_day;
  if target.id is null then raise exception 'Import tonight''s DROPS sheet first.'; end if;
  select coalesce(max(num), 0) + 1 into n from bookings where sheet_id = target.id;
  update bookings set sheet_id = target.id, moved_from = src.id, early = true, early_at = now(), num = n, updated_at = now()
    where id = b.id returning * into b;
  insert into activity(company_id, staff_id, staff_name, sheet_id, booking_id, reg, customer, action, value)
  values (c.id, s.id, s.name, target.id, b.id, b.reg, b.name, 'EARLY RETURN',
          'booked back ' || to_char(b.return_at at time zone c.time_zone, 'DD Mon HH24:MI') || ', moved from ' || to_char(src.day, 'DD Mon'));
  return b;
end;
$$;

create or replace function undo_early_return(p_booking uuid)
returns bookings language plpgsql security definer set search_path = public as $$
declare
  s staff := me();
  b bookings;
  n int;
begin
  if not can('called') then raise exception 'Not allowed for your role: %', s.role; end if;
  select * into b from bookings where id = p_booking and company_id = s.company_id and early for update;
  if b.id is null or b.moved_from is null then raise exception 'That car isn''t an early return.'; end if;
  if b.cleared_at is not null then raise exception 'That car has already gone.'; end if;
  select coalesce(max(num), 0) + 1 into n from bookings where sheet_id = b.moved_from;
  update bookings set sheet_id = b.moved_from, moved_from = null, early = false, early_at = null, num = n, updated_at = now()
    where id = b.id returning * into b;
  insert into activity(company_id, staff_id, staff_name, sheet_id, booking_id, reg, customer, action, value)
  values (s.company_id, s.id, s.name, b.sheet_id, b.id, b.reg, b.name, 'EARLY RETURN', 'undone, back on its booked day');
  return b;
end;
$$;
revoke execute on function early_return(uuid), undo_early_return(uuid) from public, anon;
grant execute on function early_return(uuid), undo_early_return(uuid) to authenticated;

create or replace function import_sheet(p_kind text, p_day date, p_rows jsonb, p_source jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s staff := me();
  c companies;
  sh sheets;
  r jsonb;
  added int := 0; updated int := 0; n_early int := 0;
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
    -- Moved off this sheet as an early return: it's on the earlier sheet now.
    if coalesce(r->>'ref', '') <> '' and exists (select 1 from bookings where company_id = c.id and moved_from = sh.id and ref = r->>'ref') then
      n_early := n_early + 1; continue;
    end if;
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
  values (c.id, s.id, s.name, sh.id, 'IMPORT', p_kind || ' ' || p_day || ': ' || added || ' added, ' || updated || ' updated' || case when n_early > 0 then ', ' || n_early || ' early return(s) left where they are' else '' end);

  return jsonb_build_object('sheet_id', sh.id, 'added', added, 'updated', updated, 'early', n_early);
end;
$$;

revoke execute on function import_sheet(text, date, jsonb, jsonb) from public, anon;
grant execute on function import_sheet(text, date, jsonb, jsonb) to authenticated;

-- Same as part 15, except an early return isn't an overstay before its booked day.
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
  update bookings b set sheet_id = target.id,
    overstay = case when b.early and coalesce((select day from sheets where id = b.moved_from), date '1900-01-01') >= shift_day then b.overstay else true end,
    early = b.early and coalesce((select day from sheets where id = b.moved_from), date '1900-01-01') > shift_day,
    moved_from = case when b.early and coalesce((select day from sheets where id = b.moved_from), date '1900-01-01') > shift_day then b.moved_from else null end,
    updated_at = now()
  from sheets old
  where b.sheet_id = old.id and old.company_id = c.id and old.kind = 'drops'
    and old.day < shift_day and old.day >= shift_day - 14 and b.cleared_at is null and b.removed_at is null;
  get diagnostics moved = row_count;
  if moved > 0 then
    insert into activity(company_id, staff_name, sheet_id, action, value)
    values (c.id, 'System', target.id, 'OVERSTAYS', moved || ' car(s) carried to ' || shift_day);
  end if;
  return moved;
end;
$$;
revoke execute on function carry_overstays(uuid) from public, anon, authenticated;
