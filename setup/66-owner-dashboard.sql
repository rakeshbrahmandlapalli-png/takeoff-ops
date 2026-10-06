-- Parking Ops — database part 66: the owner's dashboard (Menu → Dashboard).
--
-- One read for the owner and managers, for a period (last 24 hours, 7 days or
-- 30 days, chosen in the app), from what is already recorded:
--   • added    cars added at the desk: "Add a car" (ADDED) and PICKS cars
--              marked NEW BOOKING by hand (CALLED · New Booking)
--   • paid     charges paid or waived in the period (CASH / CARD / WAIVE)
--   • owed     DROPS cars with an overstay or a charge and no payment
--              recorded: still here, or cleared in the period (left unpaid).
--              The app works out the amount (overstayDue, or the agreed sum).
--   • removed  cars removed in the period, with the reason
--   • complaints  CLEAR · COMPLAINT taps in the period
--   • early / changed  how many early returns and return changes
-- Reads only; nothing changes. Safe to run twice.

create or replace function owner_dashboard(p_since timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  co uuid := my_company();
  since timestamptz := greatest(coalesce(p_since, now() - interval '7 days'), now() - interval '400 days');
begin
  if not can('settings') then raise exception 'Only the owner and managers can see the dashboard.'; end if;
  return jsonb_build_object(
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
