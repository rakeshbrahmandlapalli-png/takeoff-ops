-- Parking Ops — database part 47: an agreed overstay amount (discounts).
--
-- The office can set what a car actually owes before it's paid, e.g. £40
-- instead of the £60 worked out from the daily rate. Once set, the board and
-- the totals show that amount, and it no longer goes up each day. Setting it
-- to nothing goes back to the daily-rate sum. Recording CASH / CARD / WAIVE
-- still works as before (part 23). Safe to run twice.

alter table bookings add column if not exists charge_agreed numeric(8,2);

-- Same people who can record the payment (anyone who can CLEAR).
create or replace function set_overstay_agreed(p_booking uuid, p_amount numeric)
returns bookings language plpgsql security definer set search_path = public as $$
declare
  b bookings := booking_for_update(p_booking);
  s staff := me();
begin
  if not can('clear') then raise exception 'Not allowed for your role: %', s.role; end if;
  if b.kind <> 'drops' then raise exception 'Overstay charges are for DROPS cars.'; end if;
  if p_amount is not null and (p_amount < 0 or p_amount > 10000) then raise exception 'Check the amount.'; end if;
  update bookings set charge_agreed = p_amount, updated_at = now()
  where id = b.id returning * into b;
  perform log_activity(b, 'CHARGE', case when p_amount is null then 'Agreed amount removed' else 'Agreed £' || p_amount end);
  return b;
end;
$$;
revoke execute on function set_overstay_agreed(uuid, numeric) from public, anon;
grant execute on function set_overstay_agreed(uuid, numeric) to authenticated;
