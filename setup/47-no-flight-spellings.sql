-- Parking Ops — database part 47: "no flight" however it's typed.
--
-- 26 Sept: "NO FLYT NO" typed as five cars' flight was saved as a flight
-- number (NOFLYTNO) the checker can never find, instead of NO FLIGHT (a
-- collection time instead). NO FLT, NO FLYT, NOFLIGHTNO, NONE, N/A, NIL now all
-- mean NO FLIGHT, as in the app. A real flight never matches: it ends in
-- digits (Neos flights are NO + digits). The five cars are put right.
-- Otherwise the same as part 7. Safe to run twice.

create or replace function set_flight(p_booking uuid, p_flight text)
returns bookings language plpgsql security definer set search_path = public as $$
declare
  b bookings := booking_for_update(p_booking);
  f text := upper(regexp_replace(coalesce(p_flight, ''), '[^A-Za-z0-9]', '', 'g'));
begin
  if not can('flights') then raise exception 'Not allowed for your role: flights'; end if;
  if b.kind <> 'drops' then raise exception 'Flights are on DROPS cars.'; end if;
  if f ~ '^NOFLIGHT' or f ~ '^NOF[A-Z]*$' or f in ('NONE', 'NA', 'NIL') then f := 'NO FLIGHT'; end if;
  if length(f) > 10 then raise exception 'That does not look like a flight number.'; end if;
  if f = b.flight then return b; end if;
  update bookings set flight = f, sched_at = null, sched_time = '', est_at = null, est_time = '',
    flight_status = case when f = 'NO FLIGHT' then 'noflight' else '' end,
    flight_note = '', flight_checked_at = null, updated_at = now()
  where id = b.id returning * into b;
  perform log_activity(b, 'FLIGHT', coalesce(nullif(f, ''), '(cleared)'));
  return b;
end;
$$;
revoke execute on function set_flight(uuid, text) from public, anon;
grant execute on function set_flight(uuid, text) to authenticated;

-- The cars already saved with such a "flight".
update bookings set flight = 'NO FLIGHT', flight_status = 'noflight', sched_at = null, sched_time = '',
  flight_note = '', flight_checked_at = null, updated_at = now()
where kind = 'drops' and flight <> 'NO FLIGHT' and (flight ~ '^NOF[A-Z]*$' or flight ~ '^NOFLIGHT' or flight in ('NONE', 'NA', 'NIL'));
