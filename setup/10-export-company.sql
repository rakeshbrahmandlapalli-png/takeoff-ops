--  TAKEOFF OPS — part 10: take one company's data out, and put it back
--
--  Three jobs, one piece of work:
--
--    1. A backup. The free Supabase tier has no automatic ones. Run the export,
--       save the file, and a company's whole board can be rebuilt.
--    2. A way out. If a company ever wants their own database, export them,
--       import into the new project, done — nobody else's data comes with them.
--    3. An answer to "are we locked in?". No. Their data is theirs and they can
--       take it. That is worth saying out loud to a client.
--
--  Ids are preserved, so a restored company is the same company, not a copy.
--
--  WHAT DOES NOT TRAVEL, and why:
--    auth.users  — Supabase logins belong to the project and cannot be moved.
--                  staff rows come across with user_id emptied, so people sign
--                  in once more with a fresh personal link. Their history,
--                  bookings and sheets are all still there.
--    push_subscriptions — tied to the web address the app is served from. If
--                  the address changes they are useless, so they are left out
--                  and everyone taps "Turn on notifications" once.
--    alert_log   — only stops the same alert going twice; worthless a day later.

-- ── EXPORT ────────────────────────────────────────────────────────────────
-- select export_company('takeoff');
-- Then use the "Download JSON" button in the SQL editor, or copy the result.

create or replace function export_company(p_slug text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c companies; out jsonb;
begin
  select * into c from companies where slug = p_slug;
  if c.id is null then raise exception 'No company with slug %', p_slug; end if;

  select jsonb_build_object(
    'format',      'takeoff-ops-company-export',
    'version',     1,
    'exported_at', now(),
    'company',     to_jsonb(c),
    'staff',        coalesce((select jsonb_agg(to_jsonb(t)) from staff t where t.company_id = c.id), '[]'::jsonb),
    'staff_secrets',coalesce((select jsonb_agg(to_jsonb(s)) from staff_secrets s
                               where s.staff_id in (select id from staff where company_id = c.id)), '[]'::jsonb),
    'sheets',       coalesce((select jsonb_agg(to_jsonb(t)) from sheets t where t.company_id = c.id), '[]'::jsonb),
    'bookings',     coalesce((select jsonb_agg(to_jsonb(t)) from bookings t where t.company_id = c.id), '[]'::jsonb),
    'activity',     coalesce((select jsonb_agg(to_jsonb(t)) from activity t where t.company_id = c.id), '[]'::jsonb),
    'timetable',    coalesce((select jsonb_agg(to_jsonb(t)) from timetable t where t.company_id = c.id), '[]'::jsonb),
    'alert_prefs',  coalesce((select jsonb_agg(to_jsonb(t)) from alert_prefs t where t.company_id = c.id), '[]'::jsonb),
    'discord',      coalesce((select to_jsonb(d) from private.discord d where d.company_id = c.id), 'null'::jsonb)
  ) into out;
  return out;
end $$;

revoke execute on function export_company(text) from public, anon, authenticated;
grant execute on function export_company(text) to service_role;

-- A quick look at what an export would contain, without producing it.
create or replace function company_summary(p_slug text)
returns table (item text, count bigint) language sql security definer set search_path = public as $$
  with c as (select id from companies where slug = p_slug)
  select 'staff',     count(*) from staff     where company_id = (select id from c)
  union all select 'sheets',    count(*) from sheets    where company_id = (select id from c)
  union all select 'bookings',  count(*) from bookings  where company_id = (select id from c)
  union all select 'activity',  count(*) from activity  where company_id = (select id from c)
  union all select 'timetable', count(*) from timetable where company_id = (select id from c);
$$;
revoke execute on function company_summary(text) from public, anon, authenticated;
grant execute on function company_summary(text) to service_role;

-- ── IMPORT ────────────────────────────────────────────────────────────────
-- On the NEW project, after running parts 1 to 8:
--   select import_company('<paste the exported JSON here>'::jsonb);
--
-- Refuses if that company is already present, so it can never half-overwrite a
-- live board. To replace one deliberately, delete it first:
--   delete from companies where slug = '...';

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

  -- user_id is dropped: logins belong to the old project. Everything else,
  -- including each person's role and permissions, comes across untouched.
  insert into staff
  select (jsonb_populate_record(null::staff, r)).* from jsonb_array_elements(p_data->'staff') r;
  update staff set user_id = null where company_id = co_id;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('staff', n);

  insert into staff_secrets
  select (jsonb_populate_record(null::staff_secrets, r)).* from jsonb_array_elements(p_data->'staff_secrets') r;

  insert into sheets
  select (jsonb_populate_record(null::sheets, r)).* from jsonb_array_elements(p_data->'sheets') r;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('sheets', n);

  insert into bookings
  select (jsonb_populate_record(null::bookings, r)).* from jsonb_array_elements(p_data->'bookings') r;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('bookings', n);

  insert into activity
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

  -- activity has a bigint identity key; the sequence must be moved past the
  -- rows just inserted or the next tap collides with imported history.
  perform setval(pg_get_serial_sequence('activity', 'id'), greatest((select max(id) from activity), 1));

  return jsonb_build_object('company', co->>'name', 'restored', counts,
    'note', 'Staff must be sent fresh personal links, and each phone re-enables notifications.');
end $$;

revoke execute on function import_company(jsonb) from public, anon, authenticated;
grant execute on function import_company(jsonb) to service_role;

-- ── PROVE IT ──────────────────────────────────────────────────────────────
-- A backup nobody has restored is not a backup. This exports a company, makes a
-- throwaway copy under a new id and slug, compares the counts, then deletes the
-- copy. It never touches the company it read from.
--
--   select roundtrip_check('takeoff');

create or replace function roundtrip_check(p_slug text)
returns table (item text, original bigint, restored bigint, verdict text)
language plpgsql security definer set search_path = public as $$
declare
  data jsonb; copy_id uuid := gen_random_uuid(); copy_slug text := 'zz-roundtrip-' || substr(copy_id::text, 1, 8);
begin
  data := export_company(p_slug);

  -- same data, new identity, so it can live beside the original for a moment
  data := jsonb_set(data, '{company,id}', to_jsonb(copy_id::text));
  data := jsonb_set(data, '{company,slug}', to_jsonb(copy_slug));
  data := jsonb_set(data, '{company,name}', to_jsonb('ZZ Roundtrip Copy'::text));
  data := jsonb_set(data, '{staff}',        (select coalesce(jsonb_agg(jsonb_set(r, '{company_id}', to_jsonb(copy_id::text))), '[]'::jsonb) from jsonb_array_elements(data->'staff') r));
  data := jsonb_set(data, '{sheets}',       (select coalesce(jsonb_agg(jsonb_set(r, '{company_id}', to_jsonb(copy_id::text))), '[]'::jsonb) from jsonb_array_elements(data->'sheets') r));
  data := jsonb_set(data, '{bookings}',     (select coalesce(jsonb_agg(jsonb_set(r, '{company_id}', to_jsonb(copy_id::text))), '[]'::jsonb) from jsonb_array_elements(data->'bookings') r));
  data := jsonb_set(data, '{activity}',     (select coalesce(jsonb_agg(jsonb_set(r, '{company_id}', to_jsonb(copy_id::text))), '[]'::jsonb) from jsonb_array_elements(data->'activity') r));
  data := jsonb_set(data, '{timetable}',    (select coalesce(jsonb_agg(jsonb_set(r, '{company_id}', to_jsonb(copy_id::text))), '[]'::jsonb) from jsonb_array_elements(data->'timetable') r));
  data := jsonb_set(data, '{alert_prefs}',  (select coalesce(jsonb_agg(jsonb_set(r, '{company_id}', to_jsonb(copy_id::text))), '[]'::jsonb) from jsonb_array_elements(data->'alert_prefs') r));
  -- ids must not clash with the rows they were copied from
  data := jsonb_set(data, '{staff}',    (select coalesce(jsonb_agg(jsonb_set(r, '{id}', to_jsonb(gen_random_uuid()::text))), '[]'::jsonb) from jsonb_array_elements(data->'staff') r));
  data := jsonb_set(data, '{staff_secrets}', '[]'::jsonb);   -- link_hash is unique; not needed to count rows
  data := jsonb_set(data, '{alert_prefs}', '[]'::jsonb);     -- keyed by staff_id, which just changed
  data := jsonb_set(data, '{activity}', (select coalesce(jsonb_agg(r - 'id' - 'staff_id'), '[]'::jsonb) from jsonb_array_elements(data->'activity') r));
  data := jsonb_set(data, '{discord}', 'null'::jsonb);

  perform import_company(data);

  return query
  select s.item, s.count,
         coalesce(r.count, 0),
         case when s.item in ('staff','sheets','bookings','activity','timetable')
                   and s.count = coalesce(r.count, 0) then 'PASS' else 'FAIL' end
  from company_summary(p_slug) s
  left join company_summary(copy_slug) r on r.item = s.item;

  delete from companies where id = copy_id;
end $$;

revoke execute on function roundtrip_check(text) from public, anon, authenticated;
grant execute on function roundtrip_check(text) to service_role;

--  HOW TO USE, start to finish
--
--  Weekly backup:
--      select export_company('takeoff');        -- download the JSON, keep it safe
--
--  Check a backup is real, once in a while:
--      select * from roundtrip_check('takeoff'); -- every row must say PASS
--
--  Give a company their own database:
--      select export_company('their-slug');      -- here
--      -- on the new project: run parts 1 to 8, then
--      select import_company('<the JSON>'::jsonb);
--      -- then re-issue personal links, and delete them here once it is working
