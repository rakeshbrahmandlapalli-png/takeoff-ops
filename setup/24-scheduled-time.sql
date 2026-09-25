-- ════════════════════════════════════════════════════════════════════════
--  TAKEOFF OPS — part 24: type the scheduled landing time
--
--  Run after part 7. Safe to run again.
--
--  The flights check fills in each car's scheduled landing time from the
--  airport timetable. When it can't (flight not in the feed, check not run
--  yet), the office types the time on the car instead. It goes on whichever
--  day is nearest the booked return, so 00:30 on a 23:30 booking is the next
--  morning. If the flights check later finds the flight, its time wins.
-- ════════════════════════════════════════════════════════════════════════

begin;

create or replace function set_sched_time(p_booking uuid, p_time text)
returns bookings language plpgsql security definer set search_path = public as $$
declare
  b bookings := booking_for_update(p_booking);
  c companies;
  base timestamp;
  t timestamp;
begin
  if not can('flights') then raise exception 'Not allowed for your role: flights'; end if;
  if b.kind <> 'drops' then raise exception 'Scheduled times are on DROPS cars.'; end if;
  select * into c from companies where id = b.company_id;
  if coalesce(p_time, '') = '' then
    update bookings set sched_at = null, sched_time = '',
      flight_status = case when flight_status = 'scheduled' then '' else flight_status end, updated_at = now()
    where id = b.id returning * into b;
    perform log_activity(b, 'SCHEDULED', '(cleared)');
    return b;
  end if;
  if p_time !~ '^([01]\d|2[0-3]):[0-5]\d$' then raise exception 'Type the time as HH:MM, e.g. 14:30.'; end if;
  base := coalesce(b.return_at, now()) at time zone c.time_zone;
  t := base::date + p_time::time;
  if t < base - interval '12 hours' then t := t + interval '1 day'; end if;
  if t > base + interval '12 hours' then t := t - interval '1 day'; end if;
  update bookings set sched_at = t at time zone c.time_zone, sched_time = p_time,
    flight_status = case when flight_status = '' then 'scheduled' else flight_status end, updated_at = now()
  where id = b.id returning * into b;
  perform log_activity(b, 'SCHEDULED', p_time);
  return b;
end;
$$;
revoke execute on function set_sched_time(uuid, text) from public, anon;
grant execute on function set_sched_time(uuid, text) to authenticated;

commit;
