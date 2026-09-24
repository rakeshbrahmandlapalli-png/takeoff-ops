-- ════════════════════════════════════════════════════════════════════════
--  TAKEOFF OPS — part 7: quicker flight numbers
--
--  Run after part 3. Safe to run again.
--
--  • timetable: the flights check already downloads every arrival into the
--    airport for the day. This keeps that list, so a car with no flight
--    number is offered the flights landing near the customer's booked time:
--    one tap instead of typing. Written only by the flights function;
--    read-only for staff; cleared after 14 days.
--  • NO FLIGHT: some customers have no flight number. The office marks the
--    car NO FLIGHT and types the customer's collection time instead. Those
--    cars are never looked up, and sort by that collection time.
-- ════════════════════════════════════════════════════════════════════════
begin;

-- ── TIMETABLE ──────────────────────────────────────────────────────────
create table if not exists timetable (
  company_id  uuid not null references companies(id) on delete cascade,
  flight      text not null,
  sched_at    timestamptz not null,
  origin      text not null default '',
  status      text not null default '',
  updated_at  timestamptz not null default now(),
  primary key (company_id, flight, sched_at)
);
create index if not exists timetable_when_idx on timetable(company_id, sched_at);

alter table timetable enable row level security;
drop policy if exists timetable_read on timetable;
create policy timetable_read on timetable for select to authenticated using (company_id = my_company());
revoke all on table timetable from anon, authenticated;
grant select on table timetable to authenticated;

create or replace function trim_timetable()
returns void language sql security definer set search_path = public as $$
  delete from timetable where sched_at < now() - interval '14 days'
$$;
revoke execute on function trim_timetable() from public, anon, authenticated;
select cron.schedule('takeoff-timetable-trim', '45 2 * * *', $job$ select public.trim_timetable() $job$);

-- ── FLIGHT NUMBER, OR NO FLIGHT ────────────────────────────────────────
-- Same as part 3, plus: "no flight", "NOFLIGHT", "no flight no." all become
-- NO FLIGHT.
create or replace function set_flight(p_booking uuid, p_flight text)
returns bookings language plpgsql security definer set search_path = public as $$
declare
  b bookings := booking_for_update(p_booking);
  f text := upper(regexp_replace(coalesce(p_flight, ''), '[^A-Za-z0-9]', '', 'g'));
begin
  if not can('flights') then raise exception 'Not allowed for your role: flights'; end if;
  if b.kind <> 'drops' then raise exception 'Flights are on DROPS cars.'; end if;
  if f ~ '^NOFLIGHT' then f := 'NO FLIGHT'; end if;
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

-- The customer's collection time for a NO FLIGHT car, as HH:MM. It goes on
-- whichever day is nearest the booked return, so 00:30 on a 23:30 booking is
-- the next morning, not the morning before.
create or replace function set_collect_time(p_booking uuid, p_time text)
returns bookings language plpgsql security definer set search_path = public as $$
declare
  b bookings := booking_for_update(p_booking);
  c companies;
  base timestamp;
  t timestamp;
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
  base := coalesce(b.return_at, now()) at time zone c.time_zone;
  t := base::date + p_time::time;
  if t < base - interval '12 hours' then t := t + interval '1 day'; end if;
  if t > base + interval '12 hours' then t := t - interval '1 day'; end if;
  update bookings set est_at = t at time zone c.time_zone, est_time = p_time,
    flight_status = case when flight = 'NO FLIGHT' then 'noflight' else flight_status end, updated_at = now()
  where id = b.id returning * into b;
  perform log_activity(b, 'COLLECTION TIME', p_time);
  return b;
end;
$$;
revoke execute on function set_flight(uuid, text), set_collect_time(uuid, text) from public, anon;
grant execute on function set_flight(uuid, text), set_collect_time(uuid, text) to authenticated;

commit;
