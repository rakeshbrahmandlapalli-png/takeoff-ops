-- Parking Ops — database part 61: automatic booking imports (server-side).
--
-- The office's manual Import stays exactly as it is. This adds a path the
-- 10-minute timer (and a "Get bookings now" button) can use to import without a
-- staff login, plus a per-company on/off switch and a place to record each run.
--
-- How the timer imports safely: it acts as a dedicated "Auto import" staff row
-- (role office, so it has the import permission). That row has a random user_id
-- with no matching sign-in, so nobody can ever log in as it. import_sheet_system
-- sets that identity for the one call, then runs the SAME import_sheet the
-- office uses — so Undo, the activity log, kept work, typed flights winning and
-- changed-return-moves-day all behave identically. Cancelled bookings are left
-- for the office (they never reach import_sheet), as today.
--
-- Only the service role (the edge function) may call the system functions.
-- Safe to run twice.

-- Tidy up the throwaway function used while building this (already locked down).
drop function if exists public._imp_test();

-- Where auto-import is on, per company, with the last run's outcome for the
-- Import screen's "Bookings: connected · last update …" line.
create table if not exists private.auto_import (
  company_id   uuid primary key references companies(id) on delete cascade,
  provider     text not null default 'swift',
  enabled      boolean not null default false,
  last_run     timestamptz,
  last_ok      timestamptz,
  last_error   text,
  last_summary jsonb,
  updated_at   timestamptz not null default now()
);

-- The "Auto import" staff row for a company (made once, on first use).
create or replace function ensure_auto_staff(p_company uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  select user_id into uid from staff
    where company_id = p_company and name = 'Auto import' and coalesce(removed_at, 'infinity') = 'infinity' limit 1;
  if uid is null then
    uid := gen_random_uuid();
    insert into staff(company_id, user_id, name, role, active) values (p_company, uid, 'Auto import', 'office', true);
  end if;
  return uid;
end $$;
revoke all on function ensure_auto_staff(uuid) from public, anon, authenticated;

-- The import the timer / button uses. Service role only.
create or replace function import_sheet_system(p_company uuid, p_kind text, p_day date, p_rows jsonb, p_source jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  if p_company is null then raise exception 'No company.'; end if;
  uid := ensure_auto_staff(p_company);
  -- Act as that staff row for this one call (transaction-local).
  perform set_config('request.jwt.claims', json_build_object('sub', uid)::text, true);
  return import_sheet(p_kind, p_day, p_rows, p_source);
end $$;
revoke all on function import_sheet_system(uuid,text,date,jsonb,jsonb) from public, anon, authenticated;
grant execute on function import_sheet_system(uuid,text,date,jsonb,jsonb) to service_role;

-- The edge function records each run's outcome (service role).
create or replace function auto_import_record(p_company uuid, p_ok boolean, p_error text, p_summary jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into private.auto_import(company_id, last_run, last_ok, last_error, last_summary, updated_at)
  values (p_company, now(), case when p_ok then now() end, nullif(p_error, ''), p_summary, now())
  on conflict (company_id) do update set
    last_run = now(),
    last_ok = case when p_ok then now() else private.auto_import.last_ok end,
    last_error = nullif(p_error, ''),
    last_summary = coalesce(p_summary, private.auto_import.last_summary),
    updated_at = now();
end $$;
revoke all on function auto_import_record(uuid,boolean,text,jsonb) from public, anon, authenticated;
grant execute on function auto_import_record(uuid,boolean,text,jsonb) to service_role;

-- Which companies have it on, for the timer to loop over (service role).
create or replace function auto_import_due() returns setof companies
language sql security definer set search_path = public as $$
  select c.* from companies c join private.auto_import a on a.company_id = c.id
  where a.enabled and c.suspended_at is null
$$;
revoke all on function auto_import_due() from public, anon, authenticated;
grant execute on function auto_import_due() to service_role;

-- Office / manager: turn it on or off, and read its status, for their company.
create or replace function set_auto_import(p_enabled boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s staff := me();
begin
  if not can('import') then raise exception 'Not allowed for your role: import'; end if;
  insert into private.auto_import(company_id, enabled, updated_at) values (s.company_id, p_enabled, now())
  on conflict (company_id) do update set enabled = excluded.enabled, updated_at = now();
  insert into activity(company_id, staff_id, staff_name, action, value)
  values (s.company_id, s.id, s.name, 'AUTO IMPORT', case when p_enabled then 'turned on' else 'turned off' end);
  return jsonb_build_object('enabled', p_enabled);
end $$;
revoke all on function set_auto_import(boolean) from public, anon;
grant execute on function set_auto_import(boolean) to authenticated;

create or replace function auto_import_status() returns jsonb
language sql security definer set search_path = public as $$
  select coalesce((select to_jsonb(a) from private.auto_import a where a.company_id = (select company_id from me())),
                  '{"enabled":false}'::jsonb)
$$;
revoke all on function auto_import_status() from public, anon;
grant execute on function auto_import_status() to authenticated;

-- Check
select 'ready' as part61,
  (select count(*) from pg_proc where proname in
    ('import_sheet_system','auto_import_record','auto_import_due','set_auto_import','auto_import_status','ensure_auto_staff')) as functions;
