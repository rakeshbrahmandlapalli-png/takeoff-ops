-- Parking Ops — database part 68: the PICKS location and money carry to DROPS.
--
-- For clients with Location on PICKS switched on (part 67). When terminal
-- marks a car GS at drop-off, its DROPS car (the return) shows GS too, and
-- money noted at drop-off is owed at the return:
--   • A DROPS car added (import or Add a car) takes from its PICKS car (same
--     booking ref, or same reg when there's no ref; the latest drop-off
--     before the return):
--       - the yard, if the DROPS car has none
--       - the PICKS note, added to the DROPS note as "PICKS: …"
--       - a £ amount in that note (e.g. "£20 due") as the car's charge
--         (£X DUE, paid with CASH / CARD / WAIVE), if it has no charge yet
--   • A PICKS car's location or note changed later: the same is done to its
--     DROPS car if that's already on a sheet and not cleared. A location
--     moved (GS → T) moves the DROPS yard too, unless the office set another.
-- Each carry is in the car's history ("from PICKS"). Safe to run twice.

create or replace function carry_from_picks(p_drop uuid, p_old_yard text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  d bookings;
  p bookings;
  amt numeric;
  add_note text;
begin
  select * into d from bookings where id = p_drop and kind = 'drops' and removed_at is null and cleared_at is null;
  if not found then return; end if;
  if not exists (select 1 from companies c where c.id = d.company_id and c.brand->>'picks_yard' = 'true') then return; end if;
  select * into p from bookings x
  where x.company_id = d.company_id and x.kind = 'picks' and x.removed_at is null
    and (case when d.ref <> '' then x.ref = d.ref else x.reg = d.reg and d.reg <> '' end)
    and (d.return_at is null or x.drop_at is null or (x.drop_at <= d.return_at + interval '1 day' and x.drop_at > d.return_at - interval '120 days'))
  order by x.drop_at desc nulls last limit 1;
  if not found then return; end if;

  -- The yard: filled when empty, or moved when it still shows the PICKS car's old one.
  if p.yard <> '' and p.yard <> d.yard and (d.yard = '' or d.yard = coalesce(p_old_yard, '')) then
    update bookings set yard = p.yard, yard_before_t = '', updated_at = now() where id = d.id returning * into d;
    perform log_activity(d, 'YARD', p.yard || ' · from PICKS');
  end if;

  -- The note, once; an edited PICKS note replaces the one carried before.
  if p.note <> '' and position(p.note in d.note) = 0 then
    add_note := 'PICKS: ' || p.note;
    update bookings set note = left(case when position('PICKS: ' in d.note) > 0 then regexp_replace(d.note, 'PICKS: .*$', add_note)
      else trim(both ' ·' from d.note || case when d.note <> '' then ' · ' else '' end || add_note) end, 500), updated_at = now()
    where id = d.id returning * into d;
    perform log_activity(d, 'NOTE', add_note);
  end if;

  -- Money noted at drop-off: owed at the return, unless a charge is already set or paid.
  amt := nullif(substring(p.note from '£\s*([0-9]+(?:\.[0-9]{1,2})?)'), '')::numeric;
  if amt is not null and amt > 0 and amt <= 10000 and d.charge_agreed is null and d.charge_at is null then
    update bookings set charge_agreed = amt, charge_reason = left('noted at drop-off', 80), updated_at = now()
    where id = d.id returning * into d;
    perform log_activity(d, 'CHARGE', 'Agreed £' || amt || ' · from PICKS');
  end if;
end;
$$;
revoke execute on function carry_from_picks(uuid, text) from public, anon, authenticated;

-- A DROPS car comes in: take what its PICKS car has.
create or replace function bookings_carry_in() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform carry_from_picks(new.id);
  return null;
end;
$$;
drop trigger if exists bookings_carry_in on bookings;
create trigger bookings_carry_in after insert on bookings
  for each row when (new.kind = 'drops') execute function bookings_carry_in();

-- A PICKS car's location or note changes: pass it on to its DROPS car.
create or replace function bookings_carry_out() returns trigger
language plpgsql security definer set search_path = public as $$
declare d record;
begin
  for d in select x.id from bookings x
    where x.company_id = new.company_id and x.kind = 'drops' and x.removed_at is null and x.cleared_at is null
      and (case when new.ref <> '' then x.ref = new.ref else x.reg = new.reg and new.reg <> '' end)
      and (x.return_at is null or new.drop_at is null or x.return_at >= new.drop_at - interval '1 day')
  loop
    perform carry_from_picks(d.id, old.yard);
  end loop;
  return null;
end;
$$;
drop trigger if exists bookings_carry_out on bookings;
create trigger bookings_carry_out after update of yard, note on bookings
  for each row when (new.kind = 'picks' and (old.yard is distinct from new.yard or old.note is distinct from new.note))
  execute function bookings_carry_out();
