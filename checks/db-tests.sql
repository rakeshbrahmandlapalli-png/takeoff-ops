--  TAKEOFF OPS — database tests (run after ANY change to setup/*.sql)
--
--  Paste into the Supabase SQL editor (or run through the Supabase connector).
--  It builds two throwaway companies with staff in different roles, sheets and
--  cars, then checks the rules the app relies on: who may tap what, that one
--  company can never touch the other's cars or photos, early returns, the
--  06:00 carry-over, imports, and the PT photo links.
--
--  Nothing is kept: the whole run is ONE transaction and it always ends by
--  raising its results as an error, which rolls every row back. So "ERROR:
--  DB TESTS ..." is the normal ending — read the counts in that message.
--  Every check must say ok; a line starting FAIL is a real problem.

do $$
declare
  a_co uuid := gen_random_uuid();   b_co uuid := gen_random_uuid();
  a_own uuid := gen_random_uuid();  a_term uuid := gen_random_uuid();
  a_view uuid := gen_random_uuid(); b_own uuid := gen_random_uuid();
  a_own_s uuid; a_term_s uuid; a_view_s uuid; b_own_s uuid;
  shift date; sh_yday uuid; sh_tonight uuid; sh_tmrw uuid; sh_plus3 uuid; sh_picks uuid; b_sheet uuid;
  car_tmrw uuid; car_tonight uuid; car_yday uuid; car_gone uuid; car_pick uuid; car_b uuid;
  car_over uuid; car_early_home uuid; car_early_far uuid; car_removed uuid;
  res text[] := '{}'; fails int := 0; total int := 0;
  b bookings; j jsonb; n int; ok boolean; tok text := 'TESTtoken_abcdefghijklmnop';
begin
  -- ── fixtures ────────────────────────────────────────────────────────────
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  select '00000000-0000-0000-0000-000000000000', u, 'authenticated', 'authenticated', 'zz-dbtest-' || u || '@example.invalid', '', now(), now(), now(), '{"provider":"email"}', '{}'
  from unnest(array[a_own, a_term, a_view, b_own]) u;
  insert into companies (id, name, slug, yards) values (a_co, 'ZZ Test A', 'zz-dbtest-a', '{NY,S}'), (b_co, 'ZZ Test B', 'zz-dbtest-b', '{GS}');
  insert into staff (company_id, user_id, name, role, active) values (a_co, a_own, 'ZZ OWNER', 'owner', true) returning id into a_own_s;
  insert into staff (company_id, user_id, name, role, active) values (a_co, a_term, 'ZZ TERMINAL', 'terminal', true) returning id into a_term_s;
  insert into staff (company_id, user_id, name, role, active) values (a_co, a_view, 'ZZ VIEW', 'view', true) returning id into a_view_s;
  insert into staff (company_id, user_id, name, role, active) values (b_co, b_own, 'ZZ B OWNER', 'owner', true) returning id into b_own_s;

  select case when (now() at time zone c.time_zone)::time <= c.drops_day_end then (now() at time zone c.time_zone)::date - 1
              else (now() at time zone c.time_zone)::date end into shift from companies c where c.id = a_co;
  insert into sheets (company_id, kind, day) values (a_co, 'drops', shift - 1) returning id into sh_yday;
  insert into sheets (company_id, kind, day) values (a_co, 'drops', shift) returning id into sh_tonight;
  insert into sheets (company_id, kind, day) values (a_co, 'drops', shift + 1) returning id into sh_tmrw;
  insert into sheets (company_id, kind, day) values (a_co, 'drops', shift + 3) returning id into sh_plus3;
  insert into sheets (company_id, kind, day) values (a_co, 'picks', shift - 2) returning id into sh_picks;
  insert into sheets (company_id, kind, day) values (b_co, 'drops', shift + 1) returning id into b_sheet;

  insert into bookings (company_id, sheet_id, kind, ref, reg, name, num, return_at) values
    (a_co, sh_tmrw, 'drops', 'REF-TMRW', 'ZZ01TMR', 'Early Customer', 1, now() + interval '30 hours') returning id into car_tmrw;
  insert into bookings (company_id, sheet_id, kind, ref, reg, name, num) values (a_co, sh_tonight, 'drops', 'REF-TON', 'ZZ02TON', 'Tonight', 1) returning id into car_tonight;
  insert into bookings (company_id, sheet_id, kind, ref, reg, name, num) values (a_co, sh_yday, 'drops', 'REF-YDAY', 'ZZ03YDY', 'Overstayer', 1) returning id into car_yday;
  insert into bookings (company_id, sheet_id, kind, ref, reg, name, num, cleared_at) values (a_co, sh_tmrw, 'drops', 'REF-GONE', 'ZZ04GON', 'Gone', 2, now()) returning id into car_gone;
  insert into bookings (company_id, sheet_id, kind, ref, reg, name, num) values (a_co, sh_picks, 'picks', 'REF-TMRW', 'ZZ01TMR', 'Early Customer', 1) returning id into car_pick;
  insert into bookings (company_id, sheet_id, kind, ref, reg, name, num) values (b_co, b_sheet, 'drops', 'REF-B', 'ZZ09BBB', 'B customer', 1) returning id into car_b;

  -- ════ roles and permissions ════
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', a_term, 'role', 'authenticated')::text, true);
  begin perform tap_drop(car_tonight, 'clear', true, ''); ok := true; exception when others then ok := false; end;
  total := total + 1; res := res || (case when ok then 'ok   ' else 'FAIL ' end || 'terminal can CLEAR a car'); if not ok then fails := fails + 1; end if;
  begin perform tap_drop(car_tonight, 'called', true, ''); ok := false; exception when others then ok := true; end;
  total := total + 1; res := res || (case when ok then 'ok   ' else 'FAIL ' end || 'terminal can NOT mark CALLED'); if not ok then fails := fails + 1; end if;
  begin perform import_sheet('drops', shift, '[]'::jsonb, '{}'); ok := false; exception when others then ok := true; end;
  total := total + 1; res := res || (case when ok then 'ok   ' else 'FAIL ' end || 'terminal can NOT import sheets'); if not ok then fails := fails + 1; end if;
  begin perform early_return(car_tmrw); ok := false; exception when others then ok := true; end;
  total := total + 1; res := res || (case when ok then 'ok   ' else 'FAIL ' end || 'terminal can NOT do an early return'); if not ok then fails := fails + 1; end if;
  begin perform set_pt_method('pdf'); ok := false; exception when others then ok := true; end;
  total := total + 1; res := res || (case when ok then 'ok   ' else 'FAIL ' end || 'terminal can NOT change the PT setting'); if not ok then fails := fails + 1; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', a_view, 'role', 'authenticated')::text, true);
  begin perform tap_pick(car_pick, 'intake', 'Collected'); ok := false; exception when others then ok := true; end;
  total := total + 1; res := res || (case when ok then 'ok   ' else 'FAIL ' end || 'view-only can NOT tap COLL'); if not ok then fails := fails + 1; end if;
  begin perform pt_link_save(tok, car_pick, array[a_co || '/' || car_pick || '/' || tok || '/01.jpg']); ok := false; exception when others then ok := true; end;
  total := total + 1; res := res || (case when ok then 'ok   ' else 'FAIL ' end || 'view-only can NOT save PT photos'); if not ok then fails := fails + 1; end if;

  -- ════ taps as the owner ════
  perform set_config('request.jwt.claims', json_build_object('sub', a_own, 'role', 'authenticated')::text, true);
  b := tap_drop(car_tonight, 'sent', true, '');
  total := total + 1; ok := b.sent_at is not null and b.sent_by = a_own_s;
  res := res || (case when ok then 'ok   ' else 'FAIL ' end || 'SENT saves time and who pressed it'); if not ok then fails := fails + 1; end if;
  b := tap_pick(car_pick, 'intake', 'Collected');
  total := total + 1; ok := b.intake = 'Collected' and b.intake_by = a_own_s and b.intake_at is not null;
  res := res || (case when ok then 'ok   ' else 'FAIL ' end || 'COLL saves time and who pressed it'); if not ok then fails := fails + 1; end if;
  b := tap_pick(car_pick, 'pt', 'Done');
  total := total + 1; ok := b.pt_at is not null and b.pt_by = a_own_s;
  res := res || (case when ok then 'ok   ' else 'FAIL ' end || 'PT tick saves time and who'); if not ok then fails := fails + 1; end if;

  -- ════ early returns ════
  b := early_return(car_tmrw);
  total := total + 1; ok := b.sheet_id = sh_tonight and b.early and b.moved_from = sh_tmrw and b.early_at is not null;
  res := res || (case when ok then 'ok   ' else 'FAIL ' end || 'early return moves tomorrow''s car to tonight, marked EARLY'); if not ok then fails := fails + 1; end if;
  begin perform early_return(car_tonight); ok := false; exception when others then ok := true; end;
  total := total + 1; res := res || (case when ok then 'ok   ' else 'FAIL ' end || 'early return refused for a car already on tonight'); if not ok then fails := fails + 1; end if;
  begin perform early_return(car_yday); ok := false; exception when others then ok := true; end;
  total := total + 1; res := res || (case when ok then 'ok   ' else 'FAIL ' end || 'early return refused for an earlier day'); if not ok then fails := fails + 1; end if;
  begin perform early_return(car_gone); ok := false; exception when others then ok := true; end;
  total := total + 1; res := res || (case when ok then 'ok   ' else 'FAIL ' end || 'early return refused for a car already gone'); if not ok then fails := fails + 1; end if;
  j := import_sheet('drops', shift + 1, jsonb_build_array(jsonb_build_object('ref', 'REF-TMRW', 'reg', 'ZZ01TMR', 'name', 'Early Customer'), jsonb_build_object('ref', 'REF-NEW', 'reg', 'ZZ05NEW', 'name', 'New')), '{}');
  select count(*) into n from bookings where company_id = a_co and kind = 'drops' and ref = 'REF-TMRW';
  total := total + 1; ok := (j->>'early')::int = 1 and (j->>'added')::int = 1 and n = 1;
  res := res || (case when ok then 'ok   ' else 'FAIL ' end || 're-import of the booked day skips the early car (no copy), still adds new cars'); if not ok then fails := fails + 1; end if;
  b := undo_early_return(car_tmrw);
  total := total + 1; ok := b.sheet_id = sh_tmrw and not b.early and b.moved_from is null;
  res := res || (case when ok then 'ok   ' else 'FAIL ' end || 'undo puts it back on its booked day'); if not ok then fails := fails + 1; end if;

  -- ════ PT photo links ════
  perform pt_link_save(tok, car_pick, array[a_co || '/' || car_pick || '/' || tok || '/01.jpg', a_co || '/' || car_pick || '/' || tok || '/02.jpg']);
  perform pt_link_save(tok, car_pick, array[a_co || '/' || car_pick || '/' || tok || '/02.jpg', a_co || '/' || car_pick || '/' || tok || '/03.jpg']);
  perform set_config('role', 'postgres', true);
  select cardinality(paths) into n from pt_links where token = tok;
  perform set_config('role', 'authenticated', true);
  total := total + 1; ok := n = 3;
  res := res || (case when ok then 'ok   ' else 'FAIL ' end || 'saving a PT set twice merges the photos (3, not 4)'); if not ok then fails := fails + 1; end if;
  begin perform pt_link_save(tok, car_pick, array[b_co || '/x/' || tok || '/01.jpg']); ok := false; exception when others then ok := true; end;
  total := total + 1; res := res || (case when ok then 'ok   ' else 'FAIL ' end || 'PT save refuses a photo outside the car''s folder'); if not ok then fails := fails + 1; end if;
  begin perform pt_link_save('bad token!', car_pick, '{}'); ok := false; exception when others then ok := true; end;
  total := total + 1; res := res || (case when ok then 'ok   ' else 'FAIL ' end || 'PT save refuses a malformed link code'); if not ok then fails := fails + 1; end if;
  j := pt_photos_for(car_tmrw);
  total := total + 1; ok := jsonb_array_length(j) = 1 and (j->0->>'n')::int = 3;
  res := res || (case when ok then 'ok   ' else 'FAIL ' end || 'PT photos from PICKS show on the DROPS row (same ref)'); if not ok then fails := fails + 1; end if;
  total := total + 1; ok := set_pt_method('pdf') = 'pdf' and set_pt_method('photos') = 'photos';
  res := res || (case when ok then 'ok   ' else 'FAIL ' end || 'owner can switch PT to PDF and back'); if not ok then fails := fails + 1; end if;
  begin perform set_pt_method('fax'); ok := false; exception when others then ok := true; end;
  total := total + 1; res := res || (case when ok then 'ok   ' else 'FAIL ' end || 'PT setting refuses an unknown way'); if not ok then fails := fails + 1; end if;

  -- ════ the other company can never reach company A ════
  perform set_config('request.jwt.claims', json_build_object('sub', b_own, 'role', 'authenticated')::text, true);
  begin perform early_return(car_tmrw); ok := false; exception when others then ok := true; end;
  total := total + 1; res := res || (case when ok then 'ok   ' else 'FAIL ' end || 'company B can NOT early-return company A''s car'); if not ok then fails := fails + 1; end if;
  begin perform undo_early_return(car_tmrw); ok := false; exception when others then ok := true; end;
  total := total + 1; res := res || (case when ok then 'ok   ' else 'FAIL ' end || 'company B can NOT undo on company A''s car'); if not ok then fails := fails + 1; end if;
  begin perform pt_link_save('Btoken_abcdefghijklmnopq', car_pick, '{}'); ok := false; exception when others then ok := true; end;
  total := total + 1; res := res || (case when ok then 'ok   ' else 'FAIL ' end || 'company B can NOT save PT photos on company A''s car'); if not ok then fails := fails + 1; end if;
  j := pt_photos_for(car_pick);
  total := total + 1; ok := jsonb_array_length(j) = 0;
  res := res || (case when ok then 'ok   ' else 'FAIL ' end || 'company B sees none of company A''s PT photos'); if not ok then fails := fails + 1; end if;
  select count(*) into n from bookings where company_id = a_co;
  total := total + 1; ok := n = 0;
  res := res || (case when ok then 'ok   ' else 'FAIL ' end || 'company B reads none of company A''s cars'); if not ok then fails := fails + 1; end if;
  begin select count(*) into n from pt_links; ok := false; exception when others then ok := true; end;
  total := total + 1; res := res || (case when ok then 'ok   ' else 'FAIL ' end || 'nobody signed in can read the PT link table directly'); if not ok then fails := fails + 1; end if;
  begin perform tap_drop(car_tonight, 'sent', false, ''); ok := false; exception when others then ok := true; end;
  total := total + 1; res := res || (case when ok then 'ok   ' else 'FAIL ' end || 'company B can NOT tap company A''s car'); if not ok then fails := fails + 1; end if;

  -- ════ PT photo store (storage rule) ════
  perform set_config('request.jwt.claims', json_build_object('sub', a_own, 'role', 'authenticated')::text, true);
  begin insert into storage.objects (bucket_id, name, owner) values ('pt-photos', a_co || '/' || car_pick || '/' || tok || '/99.jpg', a_own); ok := true; exception when others then ok := false; end;
  total := total + 1; res := res || (case when ok then 'ok   ' else 'FAIL ' end || 'staff can upload a PT photo into their own company''s folder'); if not ok then fails := fails + 1; end if;
  begin insert into storage.objects (bucket_id, name, owner) values ('pt-photos', b_co || '/x/' || tok || '/01.jpg', a_own); ok := false; exception when others then ok := true; end;
  total := total + 1; res := res || (case when ok then 'ok   ' else 'FAIL ' end || 'staff can NOT upload into another company''s folder'); if not ok then fails := fails + 1; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', a_view, 'role', 'authenticated')::text, true);
  begin insert into storage.objects (bucket_id, name, owner) values ('pt-photos', a_co || '/' || car_pick || '/' || tok || '/98.jpg', a_view); ok := false; exception when others then ok := true; end;
  total := total + 1; res := res || (case when ok then 'ok   ' else 'FAIL ' end || 'view-only can NOT upload PT photos'); if not ok then fails := fails + 1; end if;

  -- ════ the 06:00 carry-over ════
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  insert into bookings (company_id, sheet_id, kind, ref, reg, name, num, early, moved_from) values
    (a_co, sh_yday, 'drops', 'REF-EH', 'ZZ06EHM', 'Early, due tonight', 5, true, sh_tonight) returning id into car_early_home;
  insert into bookings (company_id, sheet_id, kind, ref, reg, name, num, early, moved_from) values
    (a_co, sh_yday, 'drops', 'REF-EF', 'ZZ07EFR', 'Early, due in 3 days', 6, true, sh_plus3) returning id into car_early_far;
  insert into bookings (company_id, sheet_id, kind, ref, reg, name, num, removed_at) values
    (a_co, sh_yday, 'drops', 'REF-RM', 'ZZ08RMV', 'Removed', 7, now()) returning id into car_removed;
  perform carry_overstays(a_co);
  select * into b from bookings where id = car_yday;
  total := total + 1; ok := b.sheet_id = sh_tonight and b.overstay;
  res := res || (case when ok then 'ok   ' else 'FAIL ' end || 'carry-over: yesterday''s car moves to tonight as OVERSTAY'); if not ok then fails := fails + 1; end if;
  select * into b from bookings where id = car_early_home;
  total := total + 1; ok := b.sheet_id = sh_tonight and not b.overstay and not b.early and b.moved_from is null;
  res := res || (case when ok then 'ok   ' else 'FAIL ' end || 'carry-over: early car reaching its booked day is ordinary again, not OVERSTAY'); if not ok then fails := fails + 1; end if;
  select * into b from bookings where id = car_early_far;
  total := total + 1; ok := b.sheet_id = sh_tonight and not b.overstay and b.early and b.moved_from = sh_plus3;
  res := res || (case when ok then 'ok   ' else 'FAIL ' end || 'carry-over: early car still before its day stays EARLY, not OVERSTAY'); if not ok then fails := fails + 1; end if;
  select * into b from bookings where id = car_removed;
  total := total + 1; ok := b.sheet_id = sh_yday;
  res := res || (case when ok then 'ok   ' else 'FAIL ' end || 'carry-over: a removed car is never carried'); if not ok then fails := fails + 1; end if;

  -- ════ who can call what, from outside ════
  total := total + 1; ok := not has_function_privilege('anon', 'pt_link_view(text)', 'execute') and not has_function_privilege('authenticated', 'pt_link_view(text)', 'execute')
                          and not has_function_privilege('anon', 'early_return(uuid)', 'execute') and not has_function_privilege('authenticated', 'carry_overstays(uuid)', 'execute');
  res := res || (case when ok then 'ok   ' else 'FAIL ' end || 'server-only functions can''t be called from a phone'); if not ok then fails := fails + 1; end if;

  -- always roll back: the results travel in the error message
  raise exception E'DB TESTS: % passed, % failed\n%', total - fails, fails, array_to_string(res, E'\n');
end $$;
