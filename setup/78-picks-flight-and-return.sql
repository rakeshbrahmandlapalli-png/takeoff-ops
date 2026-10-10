-- Parking Ops — database part 78: the return flight and a changed return
-- time typed on a PICKS car.
--
-- Some bookings come with no flight number; the customer gives it at
-- drop-off and staff used to write it in the note. Now:
--   • set_pick_flight: a PICKS car gets a RETURN FLIGHT (anyone who takes
--     cars in, or does flights). Logged as FLIGHT in the car's history.
--   • Its DROPS car (same booking ref, or same reg when there's no ref; the
--     latest drop-off before the return, as in part 68) takes that flight if
--     it has none: when the DROPS car is added (import or Add a car), and
--     when the PICKS flight is typed after the DROPS car is already on a
--     sheet (not cleared). A flight the DROPS car already has is kept,
--     unless it came from this PICKS car and the PICKS flight is corrected.
--   • The carry is logged as FLIGHT "… · from PICKS", so a later import of
--     the DROPS sheet keeps it (part 55: a typed flight wins over the file).
--   • Notes are left as they are.
--   • set_pick_return: the office changes a PICKS car's return date and time
--     (the customer rang). Logged as RETURN CHANGED. Its DROPS car, if one is
--     already on a sheet (not cleared, not an early return), gets the same
--     change through set_return (part 54), so it moves day the same way.
-- Every client. Safe to run twice.

create or replace function set_pick_flight(p_booking uuid, p_flight text)
returns bookings language plpgsql security definer set search_path = public as $$
declare
  b bookings := booking_for_update(p_booking);
  f text := upper(regexp_replace(coalesce(p_flight, ''), '[^A-Za-z0-9]', '', 'g'));
begin
  if not (can('intake') or can('flights')) then raise exception 'Not allowed for your role: flights'; end if;
  if b.kind <> 'picks' then raise exception 'This is for PICKS cars.'; end if;
  if f ~ '^NOFLIGHT' then f := ''; end if;
  if length(f) > 10 then raise exception 'That does not look like a flight number.'; end if;
  if f = b.flight then return b; end if;
  update bookings set flight = f, updated_at = now() where id = b.id returning * into b;
  perform log_activity(b, 'FLIGHT', coalesce(nullif(f, ''), '(cleared)'));
  return b;
end;
$$;
revoke execute on function set_pick_flight(uuid, text) from public, anon;
grant execute on function set_pick_flight(uuid, text) to authenticated;

-- One DROPS car takes its PICKS car's flight, if it has none yet (or still
-- has the one the PICKS car had before it was corrected).
create or replace function carry_flight_from_picks(p_drop uuid, p_old_flight text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  d bookings;
  p bookings;
begin
  select * into d from bookings where id = p_drop and kind = 'drops' and removed_at is null and cleared_at is null;
  if not found or (d.flight <> '' and d.flight is distinct from p_old_flight) then return; end if;
  select * into p from bookings x
  where x.company_id = d.company_id and x.kind = 'picks' and x.removed_at is null
    and (case when d.ref <> '' then x.ref = d.ref else x.reg = d.reg and d.reg <> '' end)
    and (d.return_at is null or x.drop_at is null or (x.drop_at <= d.return_at + interval '1 day' and x.drop_at > d.return_at - interval '120 days'))
  order by x.drop_at desc nulls last limit 1;
  if not found or p.flight = '' or p.flight = d.flight then return; end if;
  update bookings set flight = p.flight, sched_at = null, sched_time = '', est_at = null, est_time = '',
    flight_status = '', flight_note = '', flight_checked_at = null, updated_at = now()
  where id = d.id returning * into d;
  perform log_activity(d, 'FLIGHT', p.flight || ' · from PICKS');
end;
$$;
revoke execute on function carry_flight_from_picks(uuid, text) from public, anon, authenticated;

-- A DROPS car comes in: take the PICKS car's flight.
create or replace function bookings_flight_in() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform carry_flight_from_picks(new.id);
  return null;
end;
$$;
drop trigger if exists bookings_flight_in on bookings;
create trigger bookings_flight_in after insert on bookings
  for each row when (new.kind = 'drops') execute function bookings_flight_in();

-- A PICKS car's flight is typed: pass it on to its DROPS car.
create or replace function bookings_flight_out() returns trigger
language plpgsql security definer set search_path = public as $$
declare d record;
begin
  if new.flight = '' then return null; end if;
  for d in select x.id from bookings x
    where x.company_id = new.company_id and x.kind = 'drops' and x.removed_at is null and x.cleared_at is null
      and (case when new.ref <> '' then x.ref = new.ref else x.reg = new.reg and new.reg <> '' end)
      and (x.return_at is null or new.drop_at is null or x.return_at >= new.drop_at - interval '1 day')
  loop
    perform carry_flight_from_picks(d.id, nullif(old.flight, ''));
  end loop;
  return null;
end;
$$;
drop trigger if exists bookings_flight_out on bookings;
create trigger bookings_flight_out after update of flight on bookings
  for each row when (new.kind = 'picks' and old.flight is distinct from new.flight)
  execute function bookings_flight_out();

-- The return date and time on a PICKS car ("YYYY-MM-DD HH:MI", local time).
create or replace function set_pick_return(p_booking uuid, p_return_local text)
returns bookings language plpgsql security definer set search_path = public as $$
declare
  b bookings := booking_for_update(p_booking);
  c companies;
  new_ret timestamptz;
  old_ret timestamptz;
  d record;
begin
  if not can('import') then raise exception 'Only the office can change the return date.'; end if;
  if b.kind <> 'picks' then raise exception 'This is for PICKS cars.'; end if;
  if coalesce(p_return_local, '') !~ '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$' then raise exception 'Enter the date and the time.'; end if;
  select * into c from companies where id = b.company_id;
  new_ret := p_return_local::timestamp at time zone c.time_zone;
  if new_ret < now() - interval '60 days' or new_ret > now() + interval '400 days' then raise exception 'Check the date.'; end if;
  if b.drop_at is not null and new_ret <= b.drop_at then raise exception 'The return must be after the drop-off.'; end if;
  old_ret := b.return_at;
  if old_ret is not distinct from new_ret then return b; end if;
  update bookings set return_at = new_ret, updated_at = now() where id = b.id returning * into b;
  perform log_activity(b, 'RETURN CHANGED', 'was ' || coalesce(to_char(old_ret at time zone c.time_zone, 'DD Mon HH24:MI'), '(none)') ||
    ', now ' || to_char(new_ret at time zone c.time_zone, 'DD Mon HH24:MI') || ' (changed by hand)');
  -- Its DROPS car, when it's already in: the same change.
  for d in select x.id from bookings x
    where x.company_id = b.company_id and x.kind = 'drops' and x.removed_at is null and x.cleared_at is null and not x.early
      and (case when b.ref <> '' then x.ref = b.ref else x.reg = b.reg and b.reg <> '' end)
      and (x.return_at is null or b.drop_at is null or x.return_at >= b.drop_at - interval '1 day')
  loop
    perform set_return(d.id, p_return_local);
  end loop;
  return b;
end;
$$;
revoke execute on function set_pick_return(uuid, text) from public, anon;
grant execute on function set_pick_return(uuid, text) to authenticated;
