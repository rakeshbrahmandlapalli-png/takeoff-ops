-- Parking Ops — database part 52: a charge on any DROPS car, with a reason.
--
-- Part 47's agreed amount only showed on cars already overstaying, so money
-- owed for other reasons (e.g. "return date changed, £30") went in a note
-- and could be missed at hand-back. The office can now add a charge to any
-- DROPS car with a short reason; it shows as £X DUE and is paid with CASH /
-- CARD / WAIVE like an overstay.
--   • bookings.charge_reason: the reason ('' for an overstay discount).
--   • set_overstay_agreed(car, amount, reason): as part 47, plus the reason
--     (cleared with the amount). Part 47's two-argument form now calls it.
-- Safe to run twice.

alter table bookings add column if not exists charge_reason text not null default '';

create or replace function set_overstay_agreed(p_booking uuid, p_amount numeric, p_reason text)
returns bookings language plpgsql security definer set search_path = public as $$
declare
  b bookings := booking_for_update(p_booking);
  s staff := me();
  why text := left(regexp_replace(trim(coalesce(p_reason, '')), '\s+', ' ', 'g'), 80);
begin
  if not can('clear') then raise exception 'Not allowed for your role: %', s.role; end if;
  if b.kind <> 'drops' then raise exception 'Charges are for DROPS cars.'; end if;
  if p_amount is not null and (p_amount < 0 or p_amount > 10000) then raise exception 'Check the amount.'; end if;
  update bookings set charge_agreed = p_amount, charge_reason = case when p_amount is null then '' else why end, updated_at = now()
  where id = b.id returning * into b;
  perform log_activity(b, 'CHARGE', case when p_amount is null then 'Agreed amount removed'
    else 'Agreed £' || p_amount || case when why <> '' then ' · ' || why else '' end end);
  return b;
end;
$$;
revoke execute on function set_overstay_agreed(uuid, numeric, text) from public, anon;
grant execute on function set_overstay_agreed(uuid, numeric, text) to authenticated;

create or replace function set_overstay_agreed(p_booking uuid, p_amount numeric)
returns bookings language sql security definer set search_path = public as $$
  select set_overstay_agreed(p_booking, p_amount, '')
$$;
revoke execute on function set_overstay_agreed(uuid, numeric) from public, anon;
grant execute on function set_overstay_agreed(uuid, numeric) to authenticated;
