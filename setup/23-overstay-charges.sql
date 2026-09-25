-- Parking Ops — database part 23: overstay charges.
--
-- Each company sets its own daily rate (0 = charging off). The app works out
-- what a late collection owes from the booked return time:
--   * return before the DROPS day end (06:00): free until 12:00 noon that day,
--     then one day's rate straight away and one more at every midnight after
--   * return at 06:00 or later: free until 06:00 the next morning, then one
--     day's rate straight away and one more at every 06:00 after (25 Sep)
-- (The sum is worked out in the app, overstayDue() in app.js.)
-- The office records the money as cash, card, or waived. Safe to run twice.

alter table companies add column if not exists overstay_rate numeric(8,2) not null default 0;

alter table bookings add column if not exists charge_amount numeric(8,2);
alter table bookings add column if not exists charge_method text not null default '';
alter table bookings add column if not exists charge_at     timestamptz;
alter table bookings add column if not exists charge_by     uuid references staff(id) on delete set null;

-- Office, manager and terminal (anyone who can CLEAR) record the payment.
create or replace function set_overstay_paid(p_booking uuid, p_amount numeric, p_method text)
returns bookings language plpgsql security definer set search_path = public as $$
declare
  b bookings := booking_for_update(p_booking);
  s staff := me();
begin
  if not can('clear') then raise exception 'Not allowed for your role: %', s.role; end if;
  if b.kind <> 'drops' then raise exception 'Overstay charges are for DROPS cars.'; end if;
  if p_method = '' then
    update bookings set charge_amount = null, charge_method = '', charge_at = null, charge_by = null, updated_at = now()
    where id = b.id returning * into b;
    perform log_activity(b, 'CHARGE', '(cleared)');
    return b;
  end if;
  if p_method not in ('cash', 'card', 'waived') then raise exception 'Not a valid way to pay: %', p_method; end if;
  if p_amount is null or p_amount < 0 or p_amount > 10000 then raise exception 'Check the amount.'; end if;
  update bookings set charge_amount = p_amount, charge_method = p_method, charge_at = now(), charge_by = s.id, updated_at = now()
  where id = b.id returning * into b;
  perform log_activity(b, 'CHARGE', case when p_method = 'waived' then 'Waived £' || p_amount else '£' || p_amount || ' ' || p_method end);
  return b;
end;
$$;
revoke execute on function set_overstay_paid(uuid, numeric, text) from public, anon;
grant execute on function set_overstay_paid(uuid, numeric, text) to authenticated;

create or replace function set_overstay_rate(p_rate numeric)
returns numeric language plpgsql security definer set search_path = public as $$
declare s staff := me();
begin
  if not can('settings') then raise exception 'Only an owner or manager can change settings.'; end if;
  if p_rate is null or p_rate < 0 or p_rate > 1000 then raise exception 'Check the daily rate.'; end if;
  update companies set overstay_rate = p_rate where id = s.company_id;
  insert into activity(company_id, staff_id, staff_name, action, value)
  values (s.company_id, s.id, s.name, 'SETTINGS', case when p_rate = 0 then 'Overstay charges switched off' else 'Overstay rate £' || p_rate || ' a day' end);
  return p_rate;
end;
$$;
revoke execute on function set_overstay_rate(numeric) from public, anon;
grant execute on function set_overstay_rate(numeric) to authenticated;

update companies set overstay_rate = 30 where slug = 'takeoff' and overstay_rate = 0;
