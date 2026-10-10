-- Parking Ops — database part 83: a typed time lands on the sheet's night.
--
-- set_sched_time and set_collect_time put a typed HH:MM on the day nearest the
-- booked return (part 31). With the return booked for 12:00 that is a coin toss for
-- 00:22, and it picked last night's 00:22, so the car sat at the top of tonight's
-- DROPS board (EK22RYP, 10 Oct). Now, when the nearest day is over 6 h from the
-- booking and outside the DROPS sheet's night (day_end on the sheet's day to day_end
-- the next morning), the same time on the other day, inside that night, is used.
-- Otherwise as part 31. Safe to run twice.

create or replace function set_sched_time(p_booking uuid, p_time text)
returns bookings language plpgsql security definer set search_path = public as $$
declare
  b bookings := booking_for_update(p_booking);
  c companies;
  base timestamp;
  t timestamp;
  w0 timestamp;
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
  base := (case when b.early then coalesce(b.early_at, now()) else coalesce(b.return_at, now()) end) at time zone c.time_zone;
  t := base::date + p_time::time;
  if t < base - interval '12 hours' then t := t + interval '1 day'; end if;
  if t > base + interval '12 hours' then t := t - interval '1 day'; end if;
  select sh.day + coalesce(c.drops_day_end::time, '06:00') into w0 from sheets sh where sh.id = b.sheet_id and sh.kind = 'drops';
  if w0 is not null and abs(extract(epoch from t - base)) > 6 * 3600 and not (t >= w0 and t < w0 + interval '1 day') then
    if t + interval '1 day' >= w0 and t + interval '1 day' < w0 + interval '1 day' then t := t + interval '1 day';
    elsif t - interval '1 day' >= w0 and t - interval '1 day' < w0 + interval '1 day' then t := t - interval '1 day';
    end if;
  end if;
  update bookings set sched_at = t at time zone c.time_zone, sched_time = p_time,
    flight_status = case when flight_status = '' then 'scheduled' else flight_status end,
    flight_note = case when flight_note like '%check the flight number' then '' else flight_note end, updated_at = now()
  where id = b.id returning * into b;
  perform log_activity(b, 'SCHEDULED', p_time);
  return b;
end;
$$;

create or replace function set_collect_time(p_booking uuid, p_time text)
returns bookings language plpgsql security definer set search_path = public as $$
declare
  b bookings := booking_for_update(p_booking);
  c companies;
  base timestamp;
  t timestamp;
  w0 timestamp;
begin
  if not can('flights') then raise exception 'Not allowed for your role: flights'; end if;
  if b.kind <> 'drops' then raise exception 'Collection times are on DROPS cars.'; end if;
  select * into c from companies where id = b.company_id;
  if coalesce(p_time, '') = '' then
    update bookings set est_at = null, est_time = '', updated_at = now() where id = b.id returning * into b;
    perform log_activity(b, 'COLLECTION TIME', '(cleared)');
    return b;
  end if;
  if p_time !~ '^([01]\d|2[0-3]):[0-5]\d$' then raise exception 'Type the time as HH:MM, e.g. 14:30.'; end if;
  base := (case when b.early then coalesce(b.early_at, now()) else coalesce(b.return_at, now()) end) at time zone c.time_zone;
  t := base::date + p_time::time;
  if t < base - interval '12 hours' then t := t + interval '1 day'; end if;
  if t > base + interval '12 hours' then t := t - interval '1 day'; end if;
  select sh.day + coalesce(c.drops_day_end::time, '06:00') into w0 from sheets sh where sh.id = b.sheet_id and sh.kind = 'drops';
  if w0 is not null and abs(extract(epoch from t - base)) > 6 * 3600 and not (t >= w0 and t < w0 + interval '1 day') then
    if t + interval '1 day' >= w0 and t + interval '1 day' < w0 + interval '1 day' then t := t + interval '1 day';
    elsif t - interval '1 day' >= w0 and t - interval '1 day' < w0 + interval '1 day' then t := t - interval '1 day';
    end if;
  end if;
  update bookings set est_at = t at time zone c.time_zone, est_time = p_time,
    flight_status = case when flight = 'NO FLIGHT' then 'noflight' else flight_status end, updated_at = now()
  where id = b.id returning * into b;
  perform log_activity(b, 'COLLECTION TIME', p_time);
  return b;
end;
$$;
