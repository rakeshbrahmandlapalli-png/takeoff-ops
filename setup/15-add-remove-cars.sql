-- Parking Ops — database part 15: add a car by hand, remove a no-show.
--
-- Removing never deletes: the car is marked removed with a reason, who and
-- when, drops off the board and counts, and can be put back. A removed DROPS
-- car is never carried forward as an overstay.
-- Office, manager and owner only (the same people who import).
-- Safe to run twice.

alter table bookings add column if not exists removed_at     timestamptz;
alter table bookings add column if not exists removed_by     uuid references staff(id) on delete set null;
alter table bookings add column if not exists removed_reason text not null default '';

create or replace function add_booking(p_sheet uuid, p jsonb)
returns bookings language plpgsql security definer set search_path = public as $$
declare
  s staff := me();
  c companies;
  sh sheets;
  b bookings;
  reg text := upper(regexp_replace(trim(coalesce(p->>'reg', '')), '\s+', ' ', 'g'));
  y text := upper(trim(coalesce(p->>'yard', '')));
begin
  if not can('import') then raise exception 'Only the office can add cars.'; end if;
  select * into sh from sheets where id = p_sheet and company_id = my_company();
  if not found then raise exception 'That sheet is not on your board.'; end if;
  select * into c from companies where id = sh.company_id;
  if reg = '' then raise exception 'Enter the registration.'; end if;
  if y <> '' and not (y = any(c.yards)) then raise exception 'Not a valid yard: %', y; end if;

  insert into bookings(company_id, sheet_id, kind, ref, reg, name, phone, make, drop_at, return_at, flight, yard, note, num)
  values (c.id, sh.id, sh.kind, left(trim(coalesce(p->>'ref', '')), 40), left(reg, 12),
    left(trim(coalesce(p->>'name', '')), 80), left(trim(coalesce(p->>'phone', '')), 30), left(trim(coalesce(p->>'make', '')), 60),
    nullif(p->>'drop_local', '')::timestamp at time zone c.time_zone,
    nullif(p->>'return_local', '')::timestamp at time zone c.time_zone,
    left(upper(trim(coalesce(p->>'flight', ''))), 12), case when sh.kind = 'drops' then y else '' end,
    left(trim(coalesce(p->>'note', '')), 500),
    (select coalesce(max(num), 0) + 1 from bookings where sheet_id = sh.id))
  returning * into b;
  perform log_activity(b, 'ADDED', 'added by hand');
  return b;
end;
$$;

create or replace function remove_booking(p_booking uuid, p_reason text)
returns bookings language plpgsql security definer set search_path = public as $$
declare
  b bookings := booking_for_update(p_booking);
  s staff := me();
begin
  if not can('import') then raise exception 'Only the office can remove cars.'; end if;
  if p_reason not in ('No show', 'Cancelled', 'Duplicate') then raise exception 'Not a valid reason: %', p_reason; end if;
  update bookings set removed_at = now(), removed_by = s.id, removed_reason = p_reason, updated_at = now()
  where id = b.id returning * into b;
  perform log_activity(b, 'REMOVED', p_reason);
  return b;
end;
$$;

create or replace function restore_booking(p_booking uuid)
returns bookings language plpgsql security definer set search_path = public as $$
declare
  b bookings := booking_for_update(p_booking);
begin
  if not can('import') then raise exception 'Only the office can put cars back.'; end if;
  update bookings set removed_at = null, removed_by = null, removed_reason = '', updated_at = now()
  where id = b.id returning * into b;
  perform log_activity(b, 'PUT BACK', '');
  return b;
end;
$$;

revoke execute on function add_booking(uuid, jsonb), remove_booking(uuid, text), restore_booking(uuid) from public, anon;
grant execute on function add_booking(uuid, jsonb), remove_booking(uuid, text), restore_booking(uuid) to authenticated;

-- Same as part 1, except a removed car is never carried forward.
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
