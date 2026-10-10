-- Parking Ops — database part 82: cars on site per day, counted by the app from its own cars.
--
-- The dashboard's "Cars on site" panel no longer needs a pasted report (part 81's
-- set_booked_days stays but is unused). owner_dashboard returns 'onsite': 14 days from
-- today's DROPS day, each {day, here, in, out}: cars on site at the end of that DROPS
-- day (06:00 next morning), arriving that day, returning that day. Counted from every
-- PICKS car not handed back plus DROPS cars with no PICKS car, so it knows only the
-- bookings the app holds: the nearest days are right, later days fill in as bookings
-- are imported. As part 80 otherwise. Reads only. Safe to run twice. Needs part 80.

create or replace function owner_dashboard(p_since timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  co uuid := my_company();
  since timestamptz := greatest(coalesce(p_since, now() - interval '7 days'), now() - interval '400 days');
  tz text := coalesce((select time_zone from companies where id = co), 'Europe/London');
  parked jsonb;
  onsite jsonb;
  today0 date := ((now() at time zone coalesce((select time_zone from companies where id = my_company()), 'Europe/London')) - (coalesce((select drops_day_end from companies where id = my_company()), '06:00'))::interval)::date;
  dend time := coalesce((select drops_day_end from companies where id = co), '06:00');
begin
  if not can('settings') then raise exception 'Only the owner and managers can see the dashboard.'; end if;
  with p as (
    -- Part 73: no location on PICKS → the yard the office set on its DROPS car.
    select b.return_at, b.reg, b.name, coalesce(nullif(b.yard, ''), (select d.yard from bookings d
        where d.company_id = co and d.kind = 'drops' and d.removed_at is null and d.cleared_at is null and d.yard <> ''
          and (case when b.ref <> '' then d.ref = b.ref else d.reg = b.reg and b.reg <> '' end)
        order by d.return_at nulls last limit 1), '') as yard
    from bookings b
    where b.company_id = co and b.kind = 'picks' and b.intake = 'Collected' and b.removed_at is null
      and b.return_at > now() - interval '14 days'
      and not exists (select 1 from bookings d where d.company_id = co and d.kind = 'drops' and d.removed_at is null and d.cleared_at is not null
        and (case when b.ref <> '' then d.ref = b.ref else d.reg = b.reg and b.reg <> '' end))
  )
  select jsonb_build_object('total', (select count(*) from p), 'late', (select count(*) from p where return_at <= now()),
    'late_cars', coalesce((select jsonb_agg(jsonb_build_object('reg', reg, 'name', name, 'return_at', return_at, 'yard', yard) order by return_at) from
      (select * from p where return_at <= now() order by return_at limit 200) l), '[]'),
    'days', coalesce((select jsonb_agg(jsonb_build_object('day', d, 'n', n) order by d) from
      (select (return_at at time zone tz)::date - case when (return_at at time zone tz)::time <= dend then 1 else 0 end as d, count(*) as n from p where return_at > now() group by 1) z), '[]'),
    -- Part 70: the same cars by yard ('' = no yard yet), each split by return day ('late' = past its return).
    'yards', coalesce((select jsonb_agg(jsonb_build_object('yard', y, 'n', n, 'days', days) order by n desc) from
      (select yard as y, count(*) as n,
              (select jsonb_agg(jsonb_build_object('day', d, 'n', m) order by d nulls first) from
                 (select case when q.return_at <= now() then null else (q.return_at at time zone tz)::date - case when (q.return_at at time zone tz)::time <= dend then 1 else 0 end end as d, count(*) as m
                  from p q where q.yard = p0.yard group by 1) dz) as days
       from p p0 group by yard) yz), '[]'))
  into parked;
  -- Part 82: cars on site at the end of each DROPS day (its dend, the next morning), for 14 days from
  -- today's DROPS day, from the app's own cars: every PICKS car not handed back, plus DROPS cars with no
  -- PICKS car yet. A car counts when it arrived by then and isn't back by then. 'in' = arriving that
  -- DROPS day, 'out' = returning. Only bookings the app holds count, so later days read low until
  -- their bookings are imported.
  with pk as (
    select b.ref, b.reg, b.drop_at, b.return_at from bookings b
    where b.company_id = co and b.kind = 'picks' and b.removed_at is null and b.return_at is not null
      and not exists (select 1 from bookings d where d.company_id = co and d.kind = 'drops' and d.removed_at is null and d.cleared_at is not null
        and (case when b.ref <> '' then d.ref = b.ref else d.reg = b.reg and b.reg <> '' end))
  ), dr as (
    select d.ref, d.reg, d.drop_at, d.return_at from bookings d
    where d.company_id = co and d.kind = 'drops' and d.removed_at is null and d.cleared_at is null and d.return_at is not null
      and not exists (select 1 from pk where (case when d.ref <> '' then pk.ref = d.ref else pk.reg = d.reg and d.reg <> '' end))
  ), u as (select * from pk union all select * from dr)
  select coalesce(jsonb_agg(jsonb_build_object('day', g.d, 'here', x.here, 'in', x.n_in, 'out', x.n_out) order by g.d), '[]') into onsite
  from generate_series(today0, today0 + 13, interval '1 day') gs(d0), lateral (select gs.d0::date as d) g,
    lateral (select
      count(*) filter (where coalesce(u.drop_at, '-infinity') <= ((g.d + 1) + dend) at time zone tz and u.return_at > ((g.d + 1) + dend) at time zone tz) as here,
      count(*) filter (where u.drop_at > (g.d + dend) at time zone tz and u.drop_at <= ((g.d + 1) + dend) at time zone tz) as n_in,
      count(*) filter (where u.return_at > (g.d + dend) at time zone tz and u.return_at <= ((g.d + 1) + dend) at time zone tz) as n_out
      from u) x;
  return jsonb_build_object(
    'parked', parked,
    'onsite', onsite,
    'added', coalesce((select jsonb_agg(x order by x.at desc) from (
        select a.at, a.reg, a.customer, a.staff_name, a.action, a.value, a.booking_id, s.kind, s.day
        from activity a left join sheets s on s.id = a.sheet_id
        where a.company_id = co and a.at >= since
          and (a.action = 'ADDED' or (a.action = 'CALLED' and a.value = 'New Booking'))
        order by a.at desc limit 300) x), '[]'),
    'paid', coalesce((select jsonb_agg(x order by x.charge_at desc) from (
        select b.id, b.reg, b.name, b.charge_amount, b.charge_method, b.charge_at, b.charge_reason, b.charge_agreed, st.name as by_name
        from bookings b left join staff st on st.id = b.charge_by
        where b.company_id = co and b.charge_at >= since
        order by b.charge_at desc limit 300) x), '[]'),
    'owed', coalesce((select jsonb_agg(x order by x.return_at) from (
        select b.id, b.kind, b.reg, b.name, b.return_at, b.orig_return_at, b.cleared_at, b.overstay, b.charge_agreed, b.charge_reason, s.day
        from bookings b left join sheets s on s.id = b.sheet_id
        where b.company_id = co and b.kind = 'drops' and b.removed_at is null and b.charge_at is null
          and (b.overstay or b.charge_agreed is not null)
          and (b.cleared_at is null or b.cleared_at >= since)
        order by b.return_at limit 300) x), '[]'),
    'removed', coalesce((select jsonb_agg(x order by x.removed_at desc) from (
        select b.id, b.kind, b.reg, b.name, b.removed_reason, b.removed_at, st.name as by_name
        from bookings b left join staff st on st.id = b.removed_by
        where b.company_id = co and b.removed_at >= since
        order by b.removed_at desc limit 300) x), '[]'),
    'complaints', coalesce((select jsonb_agg(x order by x.at desc) from (
        select a.at, a.reg, a.customer, a.staff_name, a.booking_id
        from activity a
        where a.company_id = co and a.at >= since and a.action = 'CLEAR' and a.value = 'COMPLAINT'
        order by a.at desc limit 300) x), '[]'),
    'early', (select count(*) from activity a where a.company_id = co and a.at >= since and a.action = 'EARLY RETURN'),
    'changed', (select count(*) from activity a where a.company_id = co and a.at >= since and a.action = 'RETURN CHANGED')
  );
end;
$$;
revoke execute on function owner_dashboard(timestamptz) from public, anon;
grant execute on function owner_dashboard(timestamptz) to authenticated;
