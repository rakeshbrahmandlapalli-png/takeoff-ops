-- Parking Ops — database part 81: cars on site per day, from the client's own booking report.
--
-- The app only knows the cars already here, not bookings still to arrive, so the
-- owner pastes the per-day totals from the booking system (date + cars on site)
-- and the dashboard draws them against the car park's capacity.
--   • companies.booked_days  jsonb {"2026-10-10": 638, ...}
--   • companies.booked_at    when it was last pasted
--   • set_booked_days(jsonb) owner and managers (can('settings')); replaces the whole
--     list; dates must be real, totals whole numbers up to 100000, at most 120 days;
--     logged as SETTINGS.
--   • owner_dashboard: as part 80, plus 'booked' and 'booked_at'.
-- Safe to run twice. Needs parts 71 and 80.

alter table companies add column if not exists booked_days jsonb not null default '{}';
alter table companies add column if not exists booked_at timestamptz;

create or replace function set_booked_days(p_days jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s staff := me();
  clean jsonb := '{}';
  k text; v text; n integer;
begin
  if not can('settings') then raise exception 'Only an owner or manager can change this.'; end if;
  if p_days is null or jsonb_typeof(p_days) <> 'object' then raise exception 'Nothing to save.'; end if;
  if (select count(*) from jsonb_object_keys(p_days)) > 120 then raise exception 'Too many days (120 at most).'; end if;
  for k, v in select key, value #>> '{}' from jsonb_each(p_days) loop
    if k !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Not a date: %', k; end if;
    begin perform k::date; exception when others then raise exception 'Not a date: %', k; end;
    if coalesce(trim(v), '') !~ '^\d{1,6}$' then raise exception 'Check the total for %.', k; end if;
    n := trim(v)::integer;
    if n > 100000 then raise exception 'Check the total for %.', k; end if;
    clean := clean || jsonb_build_object(k, n);
  end loop;
  update companies set booked_days = clean, booked_at = now() where id = s.company_id;
  insert into activity(company_id, staff_id, staff_name, action, value)
  values (s.company_id, s.id, s.name, 'SETTINGS', 'Cars on site per day pasted (' || (select count(*) from jsonb_object_keys(clean)) || ' days)');
  return jsonb_build_object('booked', clean, 'booked_at', now());
end;
$$;
revoke execute on function set_booked_days(jsonb) from public, anon;
grant execute on function set_booked_days(jsonb) to authenticated;

create or replace function owner_dashboard(p_since timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  co uuid := my_company();
  since timestamptz := greatest(coalesce(p_since, now() - interval '7 days'), now() - interval '400 days');
  tz text := coalesce((select time_zone from companies where id = co), 'Europe/London');
  parked jsonb;
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
  return jsonb_build_object(
    'parked', parked,
    'booked', coalesce((select booked_days from companies where id = co), '{}'),
    'booked_at', (select booked_at from companies where id = co),
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
