-- Parking Ops — database part 32: backups can be restored again.
--
-- import_company (part 10) could never restore a backup:
--   • staff rows went in still pointing at their old logins, which don't exist
--     in a new project, so the insert failed before user_id was cleared;
--   • activity's id is "generated always", and putting the old ids back needs
--     OVERRIDING SYSTEM VALUE.
-- Same function otherwise. Safe to run twice.

create or replace function import_company(p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  co jsonb := p_data->'company';
  co_id uuid := (co->>'id')::uuid;
  counts jsonb := '{}'::jsonb;
  n int;
begin
  if p_data->>'format' is distinct from 'takeoff-ops-company-export' then
    raise exception 'That is not a TakeOff Ops company export.';
  end if;
  if exists (select 1 from companies where id = co_id or slug = co->>'slug') then
    raise exception 'Company % is already in this database. Delete it first if you mean to replace it.', co->>'slug';
  end if;

  insert into companies select * from jsonb_populate_record(null::companies, co);

  -- Logins belong to the old project: each person comes across without one
  -- (role and permissions untouched) and is sent a fresh personal link.
  insert into staff
  select (jsonb_populate_record(null::staff, r - 'user_id')).* from jsonb_array_elements(p_data->'staff') r;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('staff', n);

  insert into staff_secrets
  select (jsonb_populate_record(null::staff_secrets, r)).* from jsonb_array_elements(p_data->'staff_secrets') r;

  insert into sheets
  select (jsonb_populate_record(null::sheets, r)).* from jsonb_array_elements(p_data->'sheets') r;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('sheets', n);

  insert into bookings
  select (jsonb_populate_record(null::bookings, r)).* from jsonb_array_elements(p_data->'bookings') r;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('bookings', n);

  insert into activity overriding system value
  select (jsonb_populate_record(null::activity, r)).* from jsonb_array_elements(p_data->'activity') r;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('activity', n);

  insert into timetable
  select (jsonb_populate_record(null::timetable, r)).* from jsonb_array_elements(p_data->'timetable') r;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('timetable', n);

  insert into alert_prefs
  select (jsonb_populate_record(null::alert_prefs, r)).* from jsonb_array_elements(p_data->'alert_prefs') r;

  if p_data->'discord' is not null and jsonb_typeof(p_data->'discord') = 'object' then
    insert into private.discord select * from jsonb_populate_record(null::private.discord, p_data->'discord');
  end if;

  -- The next tap must not collide with the history just put back.
  perform setval(pg_get_serial_sequence('activity', 'id'), greatest((select max(id) from activity), 1));

  return jsonb_build_object('company', co->>'name', 'restored', counts,
    'note', 'Staff must be sent fresh personal links, and each phone re-enables notifications.');
end $$;
revoke execute on function import_company(jsonb) from public, anon, authenticated;
