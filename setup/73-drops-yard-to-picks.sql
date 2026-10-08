-- Parking Ops — database part 73: keys marked on DROPS count on the dashboard.
--
-- Location on PICKS (part 67) is new, so most cars parked now were marked only
-- by the office on their DROPS car. Two changes:
--   • owner_dashboard: "Parked now, by yard" uses the car's PICKS location, or
--     when it has none, the yard on its DROPS car (same ref, or same reg when
--     there's no ref; not cleared). As part 70 otherwise. Reads only.
--   • set_yard: as part 67, plus when the office sets a yard on a DROPS car
--     whose PICKS car has no location yet, the PICKS car takes it ("from
--     DROPS" in its history). T (terminal) isn't copied; a PICKS location
--     already set is never changed. Only for clients with Location on PICKS.
-- Safe to run twice. Needs parts 67, 68 and 70.

create or replace function owner_dashboard(p_since timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  co uuid := my_company();
  since timestamptz := greatest(coalesce(p_since, now() - interval '7 days'), now() - interval '400 days');
  tz text := coalesce((select time_zone from companies where id = co), 'Europe/London');
  parked jsonb;
begin
  if not can('settings') then raise exception 'Only the owner and managers can see the dashboard.'; end if;
  with p as (
    -- Part 73: no location on PICKS → the yard the office set on its DROPS car.
    select b.return_at, coalesce(nullif(b.yard, ''), (select d.yard from bookings d
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
    'days', coalesce((select jsonb_agg(jsonb_build_object('day', d, 'n', n) order by d) from
      (select (return_at at time zone tz)::date as d, count(*) as n from p where return_at > now() group by 1) z), '[]'),
    -- Part 70: the same cars by yard ('' = no yard yet), each split by return day ('late' = past its return).
    'yards', coalesce((select jsonb_agg(jsonb_build_object('yard', y, 'n', n, 'days', days) order by n desc) from
      (select yard as y, count(*) as n,
              (select jsonb_agg(jsonb_build_object('day', d, 'n', m) order by d nulls first) from
                 (select case when q.return_at <= now() then null else (q.return_at at time zone tz)::date end as d, count(*) as m
                  from p q where q.yard = p0.yard group by 1) dz) as days
       from p p0 group by yard) yz), '[]'))
  into parked;
  return jsonb_build_object(
    'parked', parked,
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


create or replace function set_yard(p_booking uuid, p_yard text)
returns bookings language plpgsql security definer set search_path = public as $$
declare
  b bookings := booking_for_update(p_booking);
  y text := upper(trim(coalesce(p_yard, '')));
  yards text[];
  p bookings;
begin
  if not (can('yard') or (b.kind = 'picks' and can('intake'))) then raise exception 'Not allowed for your role: yard'; end if;
  select c.yards into yards from companies c where c.id = b.company_id;
  if y <> '' and not (y = any(yards)) then raise exception 'Not a valid yard: %', y; end if;
  -- The office's choice always wins, including T for cars left at the
  -- terminal. Forget the pre-SENT yard so undoing SENT can't overwrite it.
  update bookings set yard = y, yard_before_t = '', updated_at = now() where id = b.id returning * into b;
  perform log_activity(b, 'YARD', coalesce(nullif(y, ''), '(cleared)'));
  -- Part 73: a DROPS yard fills in its PICKS car's location when that has none
  -- (the same PICKS car part 68 carries from: latest drop-off before the return).
  if b.kind = 'drops' and y <> '' and y <> 'T'
     and exists (select 1 from companies c where c.id = b.company_id and c.brand->>'picks_yard' = 'true') then
    select * into p from bookings x
    where x.company_id = b.company_id and x.kind = 'picks' and x.removed_at is null
      and (case when b.ref <> '' then x.ref = b.ref else x.reg = b.reg and b.reg <> '' end)
      and (b.return_at is null or x.drop_at is null or (x.drop_at <= b.return_at + interval '1 day' and x.drop_at > b.return_at - interval '120 days'))
    order by x.drop_at desc nulls last limit 1;
    if found and p.yard = '' then
      update bookings set yard = y, updated_at = now() where id = p.id returning * into p;
      perform log_activity(p, 'YARD', y || ' · from DROPS');
    end if;
  end if;
  return b;
end;
$$;
revoke execute on function set_yard(uuid, text) from public, anon;
grant execute on function set_yard(uuid, text) to authenticated;
