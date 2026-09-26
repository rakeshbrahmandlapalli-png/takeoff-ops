-- Parking Ops — database part 31: fixes from the full audit.
--
--   • delete_sheet: early-return cars count as work on a sheet, so deleting
--     tonight's sheet can't delete a car brought forward onto it; cars moved
--     off a deleted sheet keep their EARLY mark but lose the undo.
--   • import_sheet: a flight number the office corrected by hand is kept on a
--     re-import instead of being overwritten by the file's.
--   • set_sched_time / set_collect_time: an early return's time is placed on
--     the night it came back, not on its booked day.
--   • wipe_old_personal: removed cars (no show, cancelled) lose their customer
--     details after the keep period like every other car.
-- Safe to run twice.

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
         count(*) filter (where overstay or early),
         count(*)
    into worked, carried, cars
  from bookings where sheet_id = sh.id;
  worked := worked + (select count(distinct booking_id) from activity where sheet_id = sh.id and action in ('NOTE', 'FLIGHT', 'COLLECTION TIME'));

  if worked > 0 then
    raise exception '% car(s) on this sheet already have taps, yards or notes. Archive it instead.', worked;
  end if;
  if carried > 0 then
    raise exception 'This sheet holds % car(s) carried from other days (overstays or early returns). Archive it instead.', carried;
  end if;

  -- Early returns moved off this sheet stay where they are; they just can't be undone back here.
  update bookings set moved_from = null where moved_from = sh.id;
  delete from sheets where id = sh.id;   -- its bookings go with it
  insert into activity(company_id, staff_id, staff_name, action, value)
  values (sh.company_id, s.id, s.name, 'SHEET DELETED', sh.kind || ' ' || sh.day || ' (' || cars || ' cars)');
  return jsonb_build_object('deleted', cars);
end;
$$;
revoke execute on function delete_sheet(uuid) from public, anon;
grant execute on function delete_sheet(uuid) to authenticated;

create or replace function import_sheet(p_kind text, p_day date, p_rows jsonb, p_source jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s staff := me();
  c companies;
  sh sheets;
  r jsonb;
  added int := 0; updated int := 0; n_early int := 0;
  next_num int;
  existing bookings;
  keep_flight boolean;
begin
  if not can('import') then raise exception 'Not allowed for your role: import'; end if;
  if p_kind not in ('drops','picks') then raise exception 'Unknown sheet type: %', p_kind; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 1000 then raise exception 'Nothing to import.'; end if;
  select * into c from companies where id = s.company_id;

  insert into sheets(company_id, kind, day, imported_by, source)
  values (c.id, p_kind, p_day, s.id, coalesce(p_source, '{}'))
  on conflict (company_id, kind, day) do update set imported_by = excluded.imported_by, imported_at = now(), source = excluded.source
  returning * into sh;
  select coalesce(max(num), 0) into next_num from bookings where sheet_id = sh.id;

  for r in select * from jsonb_array_elements(p_rows) loop
    -- Moved off this sheet as an early return: it's on the earlier sheet now.
    if coalesce(r->>'ref', '') <> '' and exists (select 1 from bookings where company_id = c.id and moved_from = sh.id and ref = r->>'ref') then
      n_early := n_early + 1; continue;
    end if;
    select * into existing from bookings
      where company_id = c.id and sheet_id = sh.id and ref <> '' and ref = coalesce(r->>'ref', '') limit 1;
    if found then
      -- A flight number the office typed in (logged as FLIGHT) wins over the
      -- file's: it was usually typed because the file's was wrong.
      keep_flight := exists (select 1 from activity where booking_id = existing.id and action = 'FLIGHT');
      if keep_flight then r := r - 'flight'; end if;
      -- A changed flight number forgets the times found for the old one.
      update bookings set
        reg = coalesce(r->>'reg', reg), name = coalesce(r->>'name', name), phone = coalesce(r->>'phone', phone),
        make = coalesce(r->>'make', make),
        drop_at = coalesce(nullif(r->>'drop_local', '')::timestamp at time zone c.time_zone, drop_at),
        return_at = coalesce(nullif(r->>'return_local', '')::timestamp at time zone c.time_zone, return_at),
        sched_at = case when coalesce(r->>'flight', '') not in ('', flight) then null else sched_at end,
        sched_time = case when coalesce(r->>'flight', '') not in ('', flight) then '' else sched_time end,
        est_at = case when coalesce(r->>'flight', '') not in ('', flight) then null else est_at end,
        est_time = case when coalesce(r->>'flight', '') not in ('', flight) then '' else est_time end,
        flight_status = case when coalesce(r->>'flight', '') not in ('', flight) then '' else flight_status end,
        flight_note = case when coalesce(r->>'flight', '') not in ('', flight) then '' else flight_note end,
        flight = case when coalesce(r->>'flight', '') <> '' then r->>'flight' else flight end,
        note = case when note = '' then coalesce(r->>'note', '') else note end,
        num = coalesce(num, next_num + 1),
        updated_at = now()
      where id = existing.id;
      if existing.num is null then next_num := next_num + 1; end if;
      updated := updated + 1;
    else
      next_num := next_num + 1;
      insert into bookings(company_id, sheet_id, kind, ref, reg, name, phone, make, drop_at, return_at, flight, note, num)
      values (c.id, sh.id, p_kind, coalesce(r->>'ref', ''), coalesce(r->>'reg', ''), coalesce(r->>'name', ''),
        coalesce(r->>'phone', ''), coalesce(r->>'make', ''),
        nullif(r->>'drop_local', '')::timestamp at time zone c.time_zone,
        nullif(r->>'return_local', '')::timestamp at time zone c.time_zone,
        coalesce(r->>'flight', ''), left(coalesce(r->>'note', ''), 500), next_num);
      added := added + 1;
    end if;
  end loop;

  insert into activity(company_id, staff_id, staff_name, sheet_id, action, value)
  values (c.id, s.id, s.name, sh.id, 'IMPORT', p_kind || ' ' || p_day || ': ' || added || ' added, ' || updated || ' updated' || case when n_early > 0 then ', ' || n_early || ' early return(s) left where they are' else '' end);

  return jsonb_build_object('sheet_id', sh.id, 'added', added, 'updated', updated, 'early', n_early);
end;
$$;
revoke execute on function import_sheet(text, date, jsonb, jsonb) from public, anon;
grant execute on function import_sheet(text, date, jsonb, jsonb) to authenticated;

-- The day a typed time belongs to: the booked return, or for an early return
-- the moment it was brought forward (tonight).
create or replace function set_sched_time(p_booking uuid, p_time text)
returns bookings language plpgsql security definer set search_path = public as $$
declare
  b bookings := booking_for_update(p_booking);
  c companies;
  base timestamp;
  t timestamp;
begin
  if not can('flights') then raise exception 'Not allowed for your role: flights'; end if;
  if b.kind <> 'drops' then raise exception 'Scheduled times are on DROPS cars.'; end if;
  select * into c from companies where id = b.company_id;
  if coalesce(p_time, '') = '' then
    update bookings set sched_at = null, sched_time = '',
      flight_status = case when flight_status = 'scheduled' then '' else flight_status end, updated_at = now()
    where id = b.id returning * into b;
    perform log_activity(b, 'SCHEDULED', '(cleared)');
    return b;
  end if;
  if p_time !~ '^([01]\d|2[0-3]):[0-5]\d$' then raise exception 'Type the time as HH:MM, e.g. 14:30.'; end if;
  base := (case when b.early then coalesce(b.early_at, now()) else coalesce(b.return_at, now()) end) at time zone c.time_zone;
  t := base::date + p_time::time;
  if t < base - interval '12 hours' then t := t + interval '1 day'; end if;
  if t > base + interval '12 hours' then t := t - interval '1 day'; end if;
  update bookings set sched_at = t at time zone c.time_zone, sched_time = p_time,
    flight_status = case when flight_status = '' then 'scheduled' else flight_status end,
    flight_note = case when flight_note like '%check the flight number' then '' else flight_note end, updated_at = now()
  where id = b.id returning * into b;
  perform log_activity(b, 'SCHEDULED', p_time);
  return b;
end;
$$;

create or replace function set_collect_time(p_booking uuid, p_time text)
returns bookings language plpgsql security definer set search_path = public as $$
declare
  b bookings := booking_for_update(p_booking);
  c companies;
  base timestamp;
  t timestamp;
begin
  if not can('flights') then raise exception 'Not allowed for your role: flights'; end if;
  if b.kind <> 'drops' then raise exception 'Collection times are on DROPS cars.'; end if;
  select * into c from companies where id = b.company_id;
  if coalesce(p_time, '') = '' then
    update bookings set est_at = null, est_time = '', updated_at = now() where id = b.id returning * into b;
    perform log_activity(b, 'COLLECTION TIME', '(cleared)');
    return b;
  end if;
  if p_time !~ '^([01]\d|2[0-3]):[0-5]\d$' then raise exception 'Type the time as HH:MM, e.g. 14:30.'; end if;
  base := (case when b.early then coalesce(b.early_at, now()) else coalesce(b.return_at, now()) end) at time zone c.time_zone;
  t := base::date + p_time::time;
  if t < base - interval '12 hours' then t := t + interval '1 day'; end if;
  if t > base + interval '12 hours' then t := t - interval '1 day'; end if;
  update bookings set est_at = t at time zone c.time_zone, est_time = p_time,
    flight_status = case when flight = 'NO FLIGHT' then 'noflight' else flight_status end, updated_at = now()
  where id = b.id returning * into b;
  perform log_activity(b, 'COLLECTION TIME', p_time);
  return b;
end;
$$;

create or replace function wipe_old_personal(p_company uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  c companies;
  cutoff date;
  n integer;
begin
  select * into c from companies where id = p_company;
  if not found then return 0; end if;
  cutoff := ((now() at time zone c.time_zone)::date - make_interval(months => c.keep_personal_months))::date;

  update bookings b set name = '', phone = '', note = '', personal_wiped_at = now()
  from sheets s
  where b.sheet_id = s.id and s.company_id = c.id and s.day < cutoff
    and b.personal_wiped_at is null
    -- a car still out (an overstay never handed back) keeps its details;
    -- a removed car (no show, cancelled) is never handed back, so it doesn't
    and (b.kind = 'picks' or b.cleared_at is not null or b.removed_at is not null);
  get diagnostics n = row_count;

  update activity a set customer = '', value = case when a.action = 'NOTE' then '(removed)' else a.value end
  where a.company_id = c.id and a.at < (cutoff::timestamp at time zone c.time_zone)
    and (a.customer <> '' or (a.action = 'NOTE' and a.value <> '(removed)'));

  if n > 0 then
    insert into activity(company_id, staff_name, action, value)
    values (c.id, 'System', 'RETENTION', 'Customer details removed from ' || n || ' booking(s) before ' || to_char(cutoff, 'DD Mon YYYY'));
  end if;
  return n;
end;
$$;
revoke execute on function wipe_old_personal(uuid) from public, anon, authenticated;
