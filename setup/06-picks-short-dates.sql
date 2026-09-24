-- ════════════════════════════════════════════════════════════════════════
--  TAKEOFF OPS — part 6: PICKS short dates
--
--  Run after part 1. Safe to run again.
--
--  On each PICKS sheet the office sets the last "short date" (e.g. 21st on
--  the 17th PICKS). Cars coming back up to then are SHORT and are parked
--  where they are easy to reach; later ones are LONG. A return up to 06:00
--  (the company's day-end) counts as the day before, so 22nd 06:00 is still
--  a 21st return. SAME DAY and NEXT DAY are worked out the same way and are
--  always part of SHORT.
-- ════════════════════════════════════════════════════════════════════════
begin;

alter table sheets add column if not exists short_until date;

create or replace function set_short_until(p_sheet uuid, p_day date)
returns sheets language plpgsql security definer set search_path = public as $$
declare
  s staff := me();
  sh sheets;
begin
  if not can('yard') then raise exception 'Only the office can set short dates.'; end if;
  select * into sh from sheets where id = p_sheet and company_id = my_company() for update;
  if not found then raise exception 'That sheet is not on your board.'; end if;
  if sh.kind <> 'picks' then raise exception 'Short dates are for PICKS sheets.'; end if;
  if p_day is not null and (p_day < sh.day or p_day > sh.day + 60) then raise exception 'Choose a date after the drop-off day.'; end if;
  update sheets set short_until = p_day where id = sh.id returning * into sh;
  insert into activity(company_id, staff_id, staff_name, sheet_id, action, value)
  values (sh.company_id, s.id, s.name, sh.id, 'SHORT DATES', coalesce('to ' || to_char(p_day, 'DD Mon'), '(cleared)'));
  return sh;
end;
$$;
revoke execute on function set_short_until(uuid, date) from public, anon;
grant execute on function set_short_until(uuid, date) to authenticated;

commit;
