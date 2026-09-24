--  TAKEOFF OPS — part 11: prove the FUNCTIONS respect company boundaries too
--
--  Part 9 tested the tables. But every write goes through a function that runs
--  as the owner and steps around row level security on purpose — tap_drop,
--  tap_pick, set_yard, set_note, set_flight, import_sheet. For those, the wall
--  is not a policy; it is a line of code inside each one. A function that
--  forgot its `and company_id = my_company()` would be a hole part 9 cannot
--  see, and the first sign would be one company moving another's car.
--
--  This signs in as one company and calls each function against the OTHER
--  company's booking. Every call must refuse, and the other company's row must
--  be untouched afterwards.
--
--  Safe on the live database: two throwaway companies, deleted at the end.

do $$
declare
  a_co uuid := gen_random_uuid();   b_co uuid := gen_random_uuid();
  a_user uuid := gen_random_uuid(); b_user uuid := gen_random_uuid();
  a_staff uuid; b_staff uuid; a_sheet uuid; b_sheet uuid; a_book uuid; b_book uuid;
  res jsonb := '[]'::jsonb;
  before_yard text; after_yard text; before_note text; after_note text;
  refused boolean;
begin
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  values ('00000000-0000-0000-0000-000000000000', a_user, 'authenticated', 'authenticated',
          'zz-fn-a@example.invalid', '', now(), now(), now(), '{"provider":"email"}', '{}'),
         ('00000000-0000-0000-0000-000000000000', b_user, 'authenticated', 'authenticated',
          'zz-fn-b@example.invalid', '', now(), now(), now(), '{"provider":"email"}', '{}');

  insert into companies (id, name, slug, yards) values
    (a_co, 'ZZ Fn A', 'zz-fn-a', '{NY,S}'), (b_co, 'ZZ Fn B', 'zz-fn-b', '{GS,MY}');
  insert into staff (company_id, user_id, name, role, active) values (a_co, a_user, 'ZZ A', 'owner', true) returning id into a_staff;
  insert into staff (company_id, user_id, name, role, active) values (b_co, b_user, 'ZZ B', 'owner', true) returning id into b_staff;
  insert into sheets (company_id, kind, day) values (a_co, 'drops', date '2001-01-02') returning id into a_sheet;
  insert into sheets (company_id, kind, day) values (b_co, 'drops', date '2001-01-02') returning id into b_sheet;
  insert into bookings (company_id, sheet_id, kind, ref, reg, name, yard, note)
  values (a_co, a_sheet, 'drops', 'ZZ-A', 'ZZ11AAA', 'Customer A', 'NY', 'A note') returning id into a_book;
  insert into bookings (company_id, sheet_id, kind, ref, reg, name, yard, note)
  values (b_co, b_sheet, 'drops', 'ZZ-B', 'ZZ11BBB', 'Customer B', 'GS', 'B note') returning id into b_book;

  select yard, note into before_yard, before_note from bookings where id = b_book;

  -- ── become company A and reach for company B's car ──────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', a_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  begin refused := false; perform tap_drop(b_book, 'sent', true, ''); exception when others then refused := true; end;
  res := res || jsonb_build_object('name', 'tap_drop on the other company''s booking', 'refused', refused);

  begin refused := false; perform tap_pick(b_book, 'intake', 'RTC'); exception when others then refused := true; end;
  res := res || jsonb_build_object('name', 'tap_pick on the other company''s booking', 'refused', refused);

  begin refused := false; perform set_yard(b_book, 'MY'); exception when others then refused := true; end;
  res := res || jsonb_build_object('name', 'set_yard on the other company''s booking', 'refused', refused);

  begin refused := false; perform set_note(b_book, 'changed by A'); exception when others then refused := true; end;
  res := res || jsonb_build_object('name', 'set_note on the other company''s booking', 'refused', refused);

  begin refused := false; perform set_flight(b_book, 'U22222'); exception when others then refused := true; end;
  res := res || jsonb_build_object('name', 'set_flight on the other company''s booking', 'refused', refused);

  -- and can still work its own board, or the wall is simply too high
  begin refused := false; perform set_yard(a_book, 'S'); exception when others then refused := true; end;
  res := res || jsonb_build_object('name', 'set_yard on its OWN booking (must NOT refuse)', 'refused', not refused);

  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);

  -- ── the other company's row must be exactly as it was ───────────────────
  select yard, note into after_yard, after_note from bookings where id = b_book;
  res := res || jsonb_build_object('name', 'the other company''s yard is unchanged', 'refused', after_yard is not distinct from before_yard);
  res := res || jsonb_build_object('name', 'the other company''s note is unchanged', 'refused', after_note is not distinct from before_note);
  res := res || jsonb_build_object('name', 'nothing was logged against the other company',
    'refused', not exists (select 1 from activity where company_id = b_co and staff_id = a_staff));

  -- ── control: the same calls DO work for their owner ─────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', b_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  begin refused := false; perform set_yard(b_book, 'MY'); exception when others then refused := true; end;
  res := res || jsonb_build_object('name', 'CONTROL: B can set_yard on its own booking', 'refused', not refused);
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  res := res || jsonb_build_object('name', 'CONTROL: that call really changed the row',
    'refused', (select yard from bookings where id = b_book) = 'MY');

  drop table if exists zz_fn_results;
  create table zz_fn_results (check_name text, verdict text);
  insert into zz_fn_results
  select r->>'name', case when (r->>'refused')::boolean then 'PASS' else 'FAIL' end
  from jsonb_array_elements(res) r;

  delete from companies where id in (a_co, b_co);
  delete from auth.users where id in (a_user, b_user);
end $$;

-- Every row must say PASS.
--   a FAIL on a "other company's" row -> one company can move another's cars.
--   a FAIL on "OWN" or "CONTROL"      -> the app itself is broken, or the test is.
select check_name, verdict from zz_fn_results order by (verdict = 'PASS'), check_name;
