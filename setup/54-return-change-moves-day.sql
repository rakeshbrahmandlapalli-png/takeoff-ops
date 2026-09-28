-- Parking Ops — database part 54: a return changed to another DROPS day goes
-- to that day's sheet.
--
-- 28 Sept: MT70WZS was changed by hand from 29 Sep 03:00 (DROPS 28th: the
-- day runs to 06:00) to 29 Sep 18:00 (DROPS 29th, already imported). It
-- stayed on the 28th in COMING UP with the old flight's 02:20, with no WAS
-- tag (same calendar date), and at 06:00 would have been carried to the
-- 29th marked OVERSTAY.
--   • set_return (part 48): compares DROPS days, not calendar dates, for the
--     WAS date (orig_return_at). When the new time belongs to a later DROPS
--     day whose sheet is already in, the car moves there (numbered next, out
--     of the overstay block, yard and notes kept). A new day forgets the old
--     day's landing times (the flight check finds the new day's).
--   • carry_overstays (part 29): a car carried onto the sheet of the day it's
--     booked back is not marked OVERSTAY.
-- Safe to run twice. Needs part 50 (drops_day_of).

create or replace function set_return(p_booking uuid, p_return_local text)
returns bookings language plpgsql security definer set search_path = public as $$
declare
  b bookings := booking_for_update(p_booking);
  s staff := me();
  c companies;
  new_ret timestamptz;
  old_ret timestamptz;
  new_day date;
  old_day date;
  first_day date;
  sheet_day date;
  target sheets;
begin
  if not can('import') then raise exception 'Only the office can change the return date.'; end if;
  if b.kind <> 'drops' then raise exception 'The return date can be changed on DROPS cars.'; end if;
  if b.early then raise exception 'This car is an early return: undo that first.'; end if;
  if b.cleared_at is not null then raise exception 'This car is already cleared.'; end if;
  if coalesce(p_return_local, '') !~ '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$' then raise exception 'Enter the date and the time.'; end if;
  select * into c from companies where id = b.company_id;
  new_ret := p_return_local::timestamp at time zone c.time_zone;
  if new_ret < now() - interval '60 days' or new_ret > now() + interval '400 days' then raise exception 'Check the date.'; end if;
  old_ret := b.return_at;
  if old_ret is not distinct from new_ret then return b; end if;
  new_day := drops_day_of(new_ret, c);
  old_day := case when old_ret is null then null else drops_day_of(old_ret, c) end;
  first_day := case when coalesce(b.orig_return_at, old_ret) is null then null else drops_day_of(coalesce(b.orig_return_at, old_ret), c) end;
  select day into sheet_day from sheets where id = b.sheet_id;
  -- A later day whose sheet is already in: the car goes there.
  if new_day > sheet_day then
    select * into target from sheets where company_id = c.id and kind = 'drops' and day = new_day;
  end if;
  update bookings set
    sheet_id = coalesce(target.id, sheet_id),
    num = case when target.id is not null then (select coalesce(max(num), 0) + 1 from bookings where sheet_id = target.id) else num end,
    orig_return_at = case
      when old_ret is null then orig_return_at
      when new_day <= first_day then null
      when new_day > old_day then coalesce(orig_return_at, old_ret)
      else orig_return_at end,
    return_at = new_ret,
    -- booked for the day of the sheet it's on now: out of the overstay block
    overstay = case when new_day = coalesce(target.day, sheet_day) then false else overstay end,
    called_word = case when new_day = coalesce(target.day, sheet_day) and called_word = 'Overstay' then '' else called_word end,
    called_at = case when new_day = coalesce(target.day, sheet_day) and called_word = 'Overstay' then null else called_at end,
    called_by = case when new_day = coalesce(target.day, sheet_day) and called_word = 'Overstay' then null else called_by end,
    -- another day: the old day's landing times don't apply
    sched_at = case when new_day is distinct from old_day then null else sched_at end,
    sched_time = case when new_day is distinct from old_day then '' else sched_time end,
    est_at = case when new_day is distinct from old_day then null else est_at end,
    est_time = case when new_day is distinct from old_day then '' else est_time end,
    flight_status = case when new_day is distinct from old_day then '' else flight_status end,
    flight_note = case when new_day is distinct from old_day then '' else flight_note end,
    updated_at = now()
  where id = b.id returning * into b;
  perform log_activity(b, 'RETURN CHANGED', 'was ' || coalesce(to_char(old_ret at time zone c.time_zone, 'DD Mon HH24:MI'), '(none)') ||
    ', now ' || to_char(new_ret at time zone c.time_zone, 'DD Mon HH24:MI') || ' (changed by hand' ||
    case when target.id is not null then '; moved to DROPS ' || to_char(target.day, 'DD Mon') else '' end || ')');
  return b;
end;
$$;
revoke execute on function set_return(uuid, text) from public, anon;
grant execute on function set_return(uuid, text) to authenticated;

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
    overstay = case when b.early and coalesce((select day from sheets where id = b.moved_from), date '1900-01-01') >= shift_day then b.overstay
                    -- booked back on this very day (return changed by hand): not an overstay
                    when not b.early and b.return_at is not null and drops_day_of(b.return_at, c) = shift_day then false
                    else true end,
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
