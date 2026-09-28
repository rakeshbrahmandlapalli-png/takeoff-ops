-- Parking Ops — database part 53: a re-import only touches cars that changed.
--
-- PICKS files are imported several times a day to stay up to date (e.g. 6
-- sheets, 3 times a day). Each import rewrote every car on the sheet, even
-- when nothing about it had changed, and every rewrite went out live to every
-- open phone: ~1,600 messages for a 100-car sheet, most saying nothing.
--   • bookings_skip_noop: while an import runs (import_sheet sets
--     takeoff.import_noop for its own transaction), an update that would leave
--     a car exactly as it is (apart from updated_at) is skipped, so nothing
--     is sent. Everything else updates as before; outside imports this does
--     nothing.
--   • import_sheet: part 50's, with the setting switched on around the import.
-- Safe to run twice.

create or replace function bookings_skip_noop()
returns trigger language plpgsql as $$
begin
  if current_setting('takeoff.import_noop', true) = 'on'
     and (to_jsonb(new) - 'updated_at') = (to_jsonb(old) - 'updated_at') then
    return null;
  end if;
  return new;
end;
$$;
drop trigger if exists bookings_skip_noop on bookings;
create trigger bookings_skip_noop before update on bookings for each row execute function bookings_skip_noop();

create or replace function import_sheet(p_kind text, p_day date, p_rows jsonb, p_source jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s staff := me();
  res jsonb;
  had_sheet boolean;
  imp_id bigint;
begin
  if not can('import') then raise exception 'Not allowed for your role: import'; end if;
  select exists (select 1 from sheets where company_id = s.company_id and kind = p_kind and day = p_day) into had_sheet;
  create temp table if not exists _imp_before (id uuid primary key, row jsonb) on commit drop;
  truncate _imp_before;
  insert into _imp_before select b.id, to_jsonb(b) - 'updated_at' from bookings b where b.company_id = s.company_id and b.kind = p_kind;

  -- Cars in the file exactly as they already are aren't rewritten (see top).
  perform set_config('takeoff.import_noop', 'on', true);
  res := import_sheet_core(p_kind, p_day, p_rows, p_source);
  perform set_config('takeoff.import_noop', 'off', true);

  delete from private.imports where at < now() - interval '2 days';
  insert into private.imports(company_id, sheet_id, kind, day, staff_id, staff_name, result, added, changed, sheet_created)
  select s.company_id, (res->>'sheet_id')::uuid, p_kind, p_day, s.id, s.name, res,
    coalesce((select array_agg(b.id) from bookings b where b.company_id = s.company_id and b.kind = p_kind
              and not exists (select 1 from _imp_before o where o.id = b.id)), '{}'),
    coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'before', o.row, 'after', to_jsonb(b) - 'updated_at'))
              from bookings b join _imp_before o on o.id = b.id where (to_jsonb(b) - 'updated_at') is distinct from o.row), '[]'),
    not had_sheet
  returning id into imp_id;
  return res || jsonb_build_object('undo_id', imp_id, 'added_ids', (select to_jsonb(added) from private.imports where id = imp_id));
end;
$$;
revoke execute on function import_sheet(text, date, jsonb, jsonb) from public, anon;
grant execute on function import_sheet(text, date, jsonb, jsonb) to authenticated;

-- The DROPS day a return belongs to: up to the day end (06:00) is the day before.
