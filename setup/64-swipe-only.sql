-- Parking Ops — database part 64: "Swipe instead of buttons" (Settings).
--
-- NOTE: superseded before release. The app now lets each person choose their
-- swipe step and whether to hide the buttons on their own phone (Menu →
-- Display), so companies.swipe_only and set_swipe_only() are not used. Both
-- are harmless (off by default) and were left in place.
--
-- In the Premium looks a bongo driver swipes a drop right to mark it SENT,
-- the office CALLED, the terminal CLEAR. With this switched on, those three
-- roles see no SENT / CALLED / CLEAR buttons on drops: they swipe, the row
-- shows what is done, and the car's panel (tap the reg) keeps the buttons to
-- undo. Owners and managers keep their buttons; picks keep theirs.
-- Off by default, so nobody changes until an owner or manager turns it on.
-- Safe to run twice.

alter table companies add column if not exists swipe_only boolean not null default false;

create or replace function set_swipe_only(p_on boolean)
returns boolean language plpgsql security definer set search_path = public as $$
declare s staff := me();
begin
  if not can('settings') then raise exception 'Only an owner or manager can change settings.'; end if;
  update companies set swipe_only = coalesce(p_on, false) where id = s.company_id;
  insert into activity(company_id, staff_id, staff_name, action, value)
  values (s.company_id, s.id, s.name, 'SETTINGS', case when p_on then 'Swipe instead of buttons: on' else 'Swipe instead of buttons: off (buttons back)' end);
  return coalesce(p_on, false);
end;
$$;
revoke execute on function set_swipe_only(boolean) from public, anon;
grant execute on function set_swipe_only(boolean) to authenticated;

-- Check: every client's setting (none changes by running this).
select name, swipe_only from companies order by name;
