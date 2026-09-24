--  TAKEOFF OPS — part 9: prove one company cannot see another's data
--
--  Row level security was written in part 1 and never tested. Before a second
--  real company shares this database, "it should be fine" is not good enough:
--  the two firms are competitors, and their customers' names, numbers and
--  registrations are in the same tables.
--
--  This builds two throwaway companies, becomes each of them in turn, and tries
--  to read the other's rows out of every table a signed-in user can reach.
--
--  It also proves the test CAN fail. The same counts are taken again with the
--  policies out of the way, and those MUST come back non-zero — a test that
--  passes because it was looking at an empty table is worse than no test.
--
--  Safe to run on the live database: it only ever touches the two companies it
--  creates, and deletes them at the end. Run it in the SQL editor, read the
--  table it prints, and run it again after ANY change to a policy or a grant.

do $$
declare
  a_co uuid := gen_random_uuid();   b_co uuid := gen_random_uuid();
  a_user uuid := gen_random_uuid(); b_user uuid := gen_random_uuid();
  a_staff uuid; b_staff uuid;
  a_sheet uuid; b_sheet uuid;
  a_book uuid;  b_book uuid;
  res jsonb := '[]'::jsonb;
  n bigint;
  add_result text := '';
begin
  -- ── fixtures ────────────────────────────────────────────────────────────
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at,
                          raw_app_meta_data, raw_user_meta_data)
  values ('00000000-0000-0000-0000-000000000000', a_user, 'authenticated', 'authenticated',
          'zz-isolation-a@example.invalid', '', now(), now(), now(), '{"provider":"email"}', '{}'),
         ('00000000-0000-0000-0000-000000000000', b_user, 'authenticated', 'authenticated',
          'zz-isolation-b@example.invalid', '', now(), now(), now(), '{"provider":"email"}', '{}');

  insert into companies (id, name, slug, yards)
  values (a_co, 'ZZ Isolation A', 'zz-isolation-a', '{NY,S}'),
         (b_co, 'ZZ Isolation B', 'zz-isolation-b', '{GS,MY}');

  insert into staff (company_id, user_id, name, role, active)
  values (a_co, a_user, 'ZZ Tester A', 'owner', true) returning id into a_staff;
  insert into staff (company_id, user_id, name, role, active)
  values (b_co, b_user, 'ZZ Tester B', 'owner', true) returning id into b_staff;

  -- hashed link + PIN, so the "nobody may read these" check has something real
  insert into staff_secrets (staff_id, link_hash, pin_hash)
  values (a_staff, 'zz-link-hash-a', 'zz-pin-hash-a'),
         (b_staff, 'zz-link-hash-b', 'zz-pin-hash-b');

  insert into sheets (company_id, kind, day) values (a_co, 'drops', date '2001-01-01') returning id into a_sheet;
  insert into sheets (company_id, kind, day) values (b_co, 'drops', date '2001-01-01') returning id into b_sheet;

  insert into bookings (company_id, sheet_id, kind, ref, reg, name, phone)
  values (a_co, a_sheet, 'drops', 'ZZ-A-REF', 'ZZ11AAA', 'Customer A', '07000000001') returning id into a_book;
  insert into bookings (company_id, sheet_id, kind, ref, reg, name, phone)
  values (b_co, b_sheet, 'drops', 'ZZ-B-REF', 'ZZ11BBB', 'Customer B', '07000000002') returning id into b_book;

  insert into activity (company_id, staff_id, staff_name, sheet_id, booking_id, reg, customer, action, value)
  values (a_co, a_staff, 'ZZ Tester A', a_sheet, a_book, 'ZZ11AAA', 'Customer A', 'ZZ', 'a'),
         (b_co, b_staff, 'ZZ Tester B', b_sheet, b_book, 'ZZ11BBB', 'Customer B', 'ZZ', 'b');

  insert into alert_prefs (staff_id, company_id) values (a_staff, a_co), (b_staff, b_co);

  insert into push_subscriptions (staff_id, company_id, endpoint, p256dh, auth)
  values (a_staff, a_co, 'https://example.invalid/zz-a', 'zz', 'zz'),
         (b_staff, b_co, 'https://example.invalid/zz-b', 'zz', 'zz');

  insert into timetable (company_id, flight, sched_at)
  values (a_co, 'ZZ1111', now()), (b_co, 'ZZ2222', now());

  -- ── become company A ────────────────────────────────────────────────────
  -- Only SELECTs run while we are this role; results are gathered in memory and
  -- written after, because `authenticated` cannot write to a scratch table.
  perform set_config('request.jwt.claims', json_build_object('sub', a_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  select count(*) into n from companies          where id = b_co;          res := res || jsonb_build_object('name','A reads B: companies','want','0','got',n);
  select count(*) into n from staff              where company_id = b_co;  res := res || jsonb_build_object('name','A reads B: staff','want','0','got',n);
  select count(*) into n from sheets             where company_id = b_co;  res := res || jsonb_build_object('name','A reads B: sheets','want','0','got',n);
  select count(*) into n from bookings           where company_id = b_co;  res := res || jsonb_build_object('name','A reads B: bookings','want','0','got',n);
  select count(*) into n from activity           where company_id = b_co;  res := res || jsonb_build_object('name','A reads B: activity','want','0','got',n);
  select count(*) into n from alert_prefs        where company_id = b_co;  res := res || jsonb_build_object('name','A reads B: alert_prefs','want','0','got',n);
  select count(*) into n from push_subscriptions where company_id = b_co;  res := res || jsonb_build_object('name','A reads B: push_subscriptions','want','0','got',n);
  select count(*) into n from timetable          where company_id = b_co;  res := res || jsonb_build_object('name','A reads B: timetable','want','0','got',n);
  select count(*) into n from flight_runs        where company_id = b_co;  res := res || jsonb_build_object('name','A reads B: flight_runs','want','0','got',n);

  -- and can still do its own job
  select count(*) into n from bookings where company_id = a_co;            res := res || jsonb_build_object('name','A sees its OWN booking','want','1','got',n);
  select count(*) into n from staff    where company_id = a_co;            res := res || jsonb_build_object('name','A sees its OWN staff','want','1','got',n);

  -- staff_secrets holds the hashed personal links and PINs. It is revoked from
  -- `authenticated` entirely, so the right answer is a refusal, not an empty
  -- result: reaching it at all would be the failure.
  begin
    select count(*) into n from staff_secrets;
    res := res || jsonb_build_object('name','staff_secrets is unreachable','want','refused','got',n);
  exception when insufficient_privilege then
    res := res || jsonb_build_object('name','staff_secrets is unreachable','want','refused','got',-1);
  end;

  -- ── become company B, the same in reverse ───────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', b_user, 'role', 'authenticated')::text, true);

  select count(*) into n from bookings where company_id = a_co;            res := res || jsonb_build_object('name','B reads A: bookings','want','0','got',n);
  select count(*) into n from staff    where company_id = a_co;            res := res || jsonb_build_object('name','B reads A: staff','want','0','got',n);
  select count(*) into n from activity where company_id = a_co;            res := res || jsonb_build_object('name','B reads A: activity','want','0','got',n);
  select count(*) into n from bookings where company_id = b_co;            res := res || jsonb_build_object('name','B sees its OWN booking','want','1','got',n);

  -- ── control: the same rows, with the policies out of the way ────────────
  -- If any of these is zero the data was never there and every zero above
  -- proved nothing at all.
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);

  select count(*) into n from bookings           where company_id = b_co;  res := res || jsonb_build_object('name','CONTROL: B bookings exist','want','>0','got',n);
  select count(*) into n from staff              where company_id = b_co;  res := res || jsonb_build_object('name','CONTROL: B staff exist','want','>0','got',n);
  select count(*) into n from activity           where company_id = a_co;  res := res || jsonb_build_object('name','CONTROL: A activity exists','want','>0','got',n);
  select count(*) into n from push_subscriptions where company_id = b_co;  res := res || jsonb_build_object('name','CONTROL: B push subs exist','want','>0','got',n);
  select count(*) into n from timetable          where company_id = b_co;  res := res || jsonb_build_object('name','CONTROL: B timetable exists','want','>0','got',n);
  select count(*) into n from staff_secrets      where staff_id in (a_staff, b_staff); res := res || jsonb_build_object('name','CONTROL: secrets exist','want','>0','got',n);

  -- ── results ─────────────────────────────────────────────────────────────
  drop table if exists zz_isolation_results;
  create table zz_isolation_results (check_name text, expected text, got text, verdict text);

  insert into zz_isolation_results
  select r->>'name', r->>'want',
         case when (r->>'got')::bigint = -1 then 'refused' else r->>'got' end,
         case
           when r->>'want' = 'refused' then case when (r->>'got')::bigint = -1 then 'PASS' else 'FAIL' end
           when r->>'want' = '>0'      then case when (r->>'got')::bigint >  0  then 'PASS' else 'FAIL' end
           else case when (r->>'got')::bigint = (r->>'want')::bigint then 'PASS' else 'FAIL' end
         end
  from jsonb_array_elements(res) r;

  -- ── clean up: none of this survives ─────────────────────────────────────
  delete from companies where id in (a_co, b_co);   -- cascades to everything else
  delete from auth.users where id in (a_user, b_user);
end $$;

-- Every row must say PASS.
--
--   a FAIL on "A reads B"  -> one company can see another's customers. STOP.
--                             Do not put a second company in this database.
--   a FAIL on "OWN"        -> isolation is too tight and the app is broken.
--   a FAIL on "CONTROL"    -> the test proved nothing; fix the test first.
select check_name, expected, got, verdict
from zz_isolation_results
order by (verdict = 'PASS'), check_name;
