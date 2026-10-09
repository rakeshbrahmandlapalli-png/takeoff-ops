-- Parking Ops — database part 74: EARLY RETURN from the PICKS car.
--
-- A customer rings to come back early, but the DROPS sheet for the day they're
-- booked back isn't imported yet, so the car has no DROPS row to move (part 29
-- needs one). early_return_from_picks puts it straight onto tonight's DROPS:
--   • Its DROPS car is already on a later sheet: the same as EARLY RETURN there.
--   • Otherwise a DROPS car is made from the PICKS car (ref, reg, name, phone,
--     car, drop-off, booked return), marked EARLY, on the sheet for the shift
--     running now. The yard, note and £ come from the PICKS car as on import
--     (part 68).
--   • It's linked to the booked day's DROPS sheet (made empty if not there
--     yet), so importing that day later leaves it where it is, not a second
--     copy (import_sheet skips a ref moved off that sheet, part 29), and
--     Undo early return puts it on that day.
-- Only cars taken in (PICKS COLLECTED), booked back after tonight. Who: anyone
-- who can press CALLED, as EARLY RETURN on DROPS. Safe to run twice.

create or replace function early_return_from_picks(p_picks uuid)
returns bookings language plpgsql security definer set search_path = public as $$
declare
  s staff := me();
  c companies;
  p bookings;
  d bookings;
  src sheets;
  target sheets;
  booked sheets;
  shift_day date;
  booked_day date;
  n int;
begin
  if not can('called') then raise exception 'Not allowed for your role: %', s.role; end if;
  select * into c from companies where id = s.company_id;
  select * into p from bookings where id = p_picks and company_id = c.id and kind = 'picks' and removed_at is null;
  if p.id is null then raise exception 'That car is not on your PICKS board.'; end if;
  if p.intake is distinct from 'Collected' then raise exception 'This car hasn''t been taken in.'; end if;
  if p.return_at is null then raise exception 'This car has no return date.'; end if;
  shift_day := case when (now() at time zone c.time_zone)::time <= c.drops_day_end
                    then (now() at time zone c.time_zone)::date - 1 else (now() at time zone c.time_zone)::date end;
  booked_day := drops_day_of(p.return_at, c);

  -- Its DROPS car, if there is one: same booking ref, or same reg when there's no ref.
  select b.* into d from bookings b
  where b.company_id = c.id and b.kind = 'drops' and b.removed_at is null
    and (case when p.ref <> '' then b.ref = p.ref
              else p.reg <> '' and upper(regexp_replace(b.reg, '\s', '', 'g')) = upper(regexp_replace(p.reg, '\s', '', 'g'))
                   and b.return_at >= coalesce(p.drop_at, p.return_at) end)
  order by b.return_at desc nulls last limit 1;
  if d.id is not null then
    if d.cleared_at is not null then raise exception 'That car has already gone.'; end if;
    if d.early then raise exception 'This car is already an early return on DROPS.'; end if;
    select * into src from sheets where id = d.sheet_id;
    if src.day <= shift_day then raise exception 'This car is already on tonight''s DROPS sheet or an earlier one.'; end if;
    return early_return(d.id);
  end if;

  if booked_day <= shift_day then raise exception 'This car is booked back tonight: import tonight''s DROPS sheet.'; end if;
  select * into target from sheets where company_id = c.id and kind = 'drops' and day = shift_day;
  if target.id is null then raise exception 'Import tonight''s DROPS sheet first.'; end if;
  insert into sheets(company_id, kind, day, imported_by, source)
  values (c.id, 'drops', booked_day, s.id, '{}')
  on conflict (company_id, kind, day) do nothing;
  select * into booked from sheets where company_id = c.id and kind = 'drops' and day = booked_day;
  select coalesce(max(num), 0) + 1 into n from bookings where sheet_id = target.id;
  insert into bookings(company_id, sheet_id, kind, ref, reg, name, phone, make, drop_at, return_at, num, early, early_at, moved_from)
  values (c.id, target.id, 'drops', p.ref, p.reg, p.name, p.phone, p.make, p.drop_at, p.return_at, n, true, now(), booked.id)
  returning * into d;
  -- The yard, note and £ came over from the PICKS car on insert (part 68's trigger).
  select * into d from bookings where id = d.id;
  insert into activity(company_id, staff_id, staff_name, sheet_id, booking_id, reg, customer, action, value)
  values (c.id, s.id, s.name, target.id, d.id, d.reg, d.name, 'EARLY RETURN',
          'booked back ' || to_char(d.return_at at time zone c.time_zone, 'DD Mon HH24:MI') || ', added from PICKS');
  return d;
end;
$$;
revoke execute on function early_return_from_picks(uuid) from public, anon;
grant execute on function early_return_from_picks(uuid) to authenticated;
