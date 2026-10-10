-- Parking Ops — database part 75: EARLY RETURN on a night you pick.
--
-- A customer booked back on the 14th rings on the 10th to say they'll come on
-- the 12th. EARLY RETURN (part 29 on DROPS, part 74 on PICKS) now takes the
-- night they're coming (p_day, the DROPS day); null, or the old one-argument call, = tonight.
--   • Any night from tonight up to the day before the car's booked day.
--   • Tonight: tonight's DROPS sheet must be imported, as before.
--   • A later night: the car goes onto that night's DROPS sheet, made empty
--     if it isn't imported yet; that night's import adds the other cars.
--     early_at is 18:00 that day, so it sorts in that night's queue and a
--     typed collection time lands on that night (part 31 uses early_at).
--   • The booked day's import still leaves it where it is (part 29), and
--     Undo early return puts it back on the booked day.
-- Otherwise as parts 29 and 74. Safe to run twice.

-- The night picked: checked, and its DROPS sheet (made if it's a later night).
create or replace function early_night(c companies, p_day date, p_before date, staff_id uuid)
returns sheets language plpgsql security definer set search_path = public as $$
declare
  shift_day date := case when (now() at time zone c.time_zone)::time <= c.drops_day_end
                         then (now() at time zone c.time_zone)::date - 1 else (now() at time zone c.time_zone)::date end;
  d date := coalesce(p_day, shift_day);
  t sheets;
begin
  if d < shift_day then raise exception 'Pick tonight or a later night.'; end if;
  if d >= p_before then raise exception 'Pick a night before the day it''s booked back (%).', to_char(p_before, 'DD Mon'); end if;
  if d = shift_day then
    select * into t from sheets where company_id = c.id and kind = 'drops' and day = d;
    if t.id is null then raise exception 'Import tonight''s DROPS sheet first.'; end if;
    return t;
  end if;
  insert into sheets(company_id, kind, day, imported_by, source) values (c.id, 'drops', d, staff_id, '{}')
  on conflict (company_id, kind, day) do nothing;
  select * into t from sheets where company_id = c.id and kind = 'drops' and day = d;
  return t;
end;
$$;
revoke execute on function early_night(companies, date, date, uuid) from public, anon, authenticated;

-- When an early car is due: now for tonight, 18:00 on a later night.
create or replace function early_at_for(c companies, t sheets)
returns timestamptz language sql stable as $$
  select case when t.day > (case when (now() at time zone c.time_zone)::time <= c.drops_day_end
                                 then (now() at time zone c.time_zone)::date - 1 else (now() at time zone c.time_zone)::date end)
              then (t.day + time '18:00') at time zone c.time_zone else now() end
$$;
revoke execute on function early_at_for(companies, sheets) from public, anon, authenticated;

create or replace function early_return(p_booking uuid, p_day date)
returns bookings language plpgsql security definer set search_path = public as $$
declare
  s staff := me();
  c companies;
  b bookings;
  src sheets;
  target sheets;
  n int;
begin
  if not can('called') then raise exception 'Not allowed for your role: %', s.role; end if;
  select * into c from companies where id = s.company_id;
  select * into b from bookings where id = p_booking and company_id = c.id and kind = 'drops' for update;
  if b.id is null then raise exception 'That car is not on your DROPS board.'; end if;
  if b.cleared_at is not null then raise exception 'That car has already gone.'; end if;
  if b.early then raise exception 'This car is already an early return: undo that first.'; end if;
  select * into src from sheets where id = b.sheet_id;
  target := early_night(c, p_day, src.day, s.id);
  select coalesce(max(num), 0) + 1 into n from bookings where sheet_id = target.id;
  update bookings set sheet_id = target.id, moved_from = src.id, early = true, early_at = early_at_for(c, target), num = n, updated_at = now()
    where id = b.id returning * into b;
  insert into activity(company_id, staff_id, staff_name, sheet_id, booking_id, reg, customer, action, value)
  values (c.id, s.id, s.name, target.id, b.id, b.reg, b.name, 'EARLY RETURN',
          'booked back ' || to_char(b.return_at at time zone c.time_zone, 'DD Mon HH24:MI') || ', moved from ' || to_char(src.day, 'DD Mon')
          || ' to ' || to_char(target.day, 'DD Mon'));
  return b;
end;
$$;
revoke execute on function early_return(uuid, date) from public, anon;
grant execute on function early_return(uuid, date) to authenticated;

-- The one-argument versions (parts 29 and 74, still called by phones on the
-- old app until they update): tonight.
create or replace function early_return(p_booking uuid)
returns bookings language sql security definer set search_path = public as $$ select early_return(p_booking, null::date) $$;

create or replace function early_return_from_picks(p_picks uuid, p_day date)
returns bookings language plpgsql security definer set search_path = public as $$
declare
  s staff := me();
  c companies;
  p bookings;
  d bookings;
  target sheets;
  booked sheets;
  booked_day date;
  n int;
begin
  if not can('called') then raise exception 'Not allowed for your role: %', s.role; end if;
  select * into c from companies where id = s.company_id;
  select * into p from bookings where id = p_picks and company_id = c.id and kind = 'picks' and removed_at is null;
  if p.id is null then raise exception 'That car is not on your PICKS board.'; end if;
  if p.intake is distinct from 'Collected' then raise exception 'This car hasn''t been taken in.'; end if;
  if p.return_at is null then raise exception 'This car has no return date.'; end if;
  booked_day := drops_day_of(p.return_at, c);

  -- Its DROPS car, if there is one: same booking ref, or same reg when there's no ref.
  select b.* into d from bookings b
  where b.company_id = c.id and b.kind = 'drops' and b.removed_at is null
    and (case when p.ref <> '' then b.ref = p.ref
              else p.reg <> '' and upper(regexp_replace(b.reg, '\s', '', 'g')) = upper(regexp_replace(p.reg, '\s', '', 'g'))
                   and b.return_at >= coalesce(p.drop_at, p.return_at) end)
  order by b.return_at desc nulls last limit 1;
  if d.id is not null then return early_return(d.id, p_day); end if;

  target := early_night(c, p_day, booked_day, s.id);
  insert into sheets(company_id, kind, day, imported_by, source)
  values (c.id, 'drops', booked_day, s.id, '{}')
  on conflict (company_id, kind, day) do nothing;
  select * into booked from sheets where company_id = c.id and kind = 'drops' and day = booked_day;
  select coalesce(max(num), 0) + 1 into n from bookings where sheet_id = target.id;
  insert into bookings(company_id, sheet_id, kind, ref, reg, name, phone, make, drop_at, return_at, num, early, early_at, moved_from)
  values (c.id, target.id, 'drops', p.ref, p.reg, p.name, p.phone, p.make, p.drop_at, p.return_at, n, true, early_at_for(c, target), booked.id)
  returning * into d;
  -- The yard, note and £ came over from the PICKS car on insert (part 68's trigger).
  select * into d from bookings where id = d.id;
  insert into activity(company_id, staff_id, staff_name, sheet_id, booking_id, reg, customer, action, value)
  values (c.id, s.id, s.name, target.id, d.id, d.reg, d.name, 'EARLY RETURN',
          'booked back ' || to_char(d.return_at at time zone c.time_zone, 'DD Mon HH24:MI') || ', added from PICKS to ' || to_char(target.day, 'DD Mon'));
  return d;
end;
$$;
revoke execute on function early_return_from_picks(uuid, date) from public, anon;
grant execute on function early_return_from_picks(uuid, date) to authenticated;

create or replace function early_return_from_picks(p_picks uuid)
returns bookings language sql security definer set search_path = public as $$ select early_return_from_picks(p_picks, null::date) $$;
