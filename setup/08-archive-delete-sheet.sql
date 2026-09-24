-- ════════════════════════════════════════════════════════════════════════
--  TAKEOFF OPS — part 8: archive or delete one sheet by hand
--
--  Run after part 1. Safe to run again.
--
--  Owner, office and manager (the people who can import):
--    • archive_sheet: takes a finished sheet out of the list at the top now,
--      instead of after 90 days. It stays on the Archive screen and can be
--      brought back. Nothing on it changes.
--    • delete_sheet: removes a wrong import completely. Refused once real
--      work is on it (any tap, yard or note typed by staff) and when it holds
--      overstays carried from earlier days, so deleting can never wipe a
--      shift's record or someone else's cars. The deletion is logged.
-- ════════════════════════════════════════════════════════════════════════
begin;

alter table sheets add column if not exists archived_at timestamptz;
alter table sheets add column if not exists archived_by uuid references staff(id) on delete set null;

create or replace function archive_sheet(p_sheet uuid, p_archive boolean)
returns sheets language plpgsql security definer set search_path = public as $$
declare
  s staff := me();
  sh sheets;
begin
  if not can('import') then raise exception 'Only the office can archive sheets.'; end if;
  select * into sh from sheets where id = p_sheet and company_id = my_company() for update;
  if not found then raise exception 'That sheet is not on your board.'; end if;
  update sheets set archived_at = case when p_archive then now() end, archived_by = case when p_archive then s.id end
  where id = sh.id returning * into sh;
  insert into activity(company_id, staff_id, staff_name, sheet_id, action, value)
  values (sh.company_id, s.id, s.name, sh.id, case when p_archive then 'SHEET ARCHIVED' else 'SHEET RESTORED' end, sh.kind || ' ' || sh.day);
  return sh;
end;
$$;

create or replace function delete_sheet(p_sheet uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s staff := me();
  sh sheets;
  worked int;
  carried int;
  cars int;
begin
  if not can('import') then raise exception 'Only the office can delete sheets.'; end if;
  select * into sh from sheets where id = p_sheet and company_id = my_company() for update;
  if not found then raise exception 'That sheet is not on your board.'; end if;

  select count(*) filter (where sent_at is not null or called_at is not null or cleared_at is not null
                            or intake <> '' or pt_at is not null or pick_called <> '' or yard <> ''),
         count(*) filter (where overstay),
         count(*)
    into worked, carried, cars
  from bookings where sheet_id = sh.id;
  -- A note typed by staff is logged; one that came in with the import is not.
  worked := worked + (select count(distinct booking_id) from activity where sheet_id = sh.id and action in ('NOTE', 'FLIGHT', 'COLLECTION TIME'));

  if worked > 0 then
    raise exception '% car(s) on this sheet already have taps, yards or notes. Archive it instead.', worked;
  end if;
  if carried > 0 then
    raise exception 'This sheet holds % overstay(s) carried from earlier days. Archive it instead.', carried;
  end if;

  delete from sheets where id = sh.id;   -- its bookings go with it
  insert into activity(company_id, staff_id, staff_name, action, value)
  values (sh.company_id, s.id, s.name, 'SHEET DELETED', sh.kind || ' ' || sh.day || ' (' || cars || ' cars)');
  return jsonb_build_object('deleted', cars);
end;
$$;

revoke execute on function archive_sheet(uuid, boolean), delete_sheet(uuid) from public, anon;
grant execute on function archive_sheet(uuid, boolean), delete_sheet(uuid) to authenticated;

commit;
