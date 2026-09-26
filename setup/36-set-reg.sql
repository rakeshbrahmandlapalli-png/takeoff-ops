-- Parking Ops — database part 36: the reg can be typed in.
--
-- Some bookings come from the booking system with no reg (7 in the first
-- week). PT then gets "NO REG" on WhatsApp. Now:
--   • set_reg: office staff, and drivers for a car that has no reg yet, type
--     the reg in the car's panel (logged as REG); the booking's other row
--     (PICKS / DROPS, same ref) gets it too, now or when it's imported;
--   • import_sheet: a blank reg, name, phone or car in a re-imported file no
--     longer wipes what's already there. Otherwise the same as part 33.
-- Safe to run twice.

create or replace function set_reg(p_booking uuid, p_reg text)
returns bookings language plpgsql security definer set search_path = public as $$
declare
  b bookings := booking_for_update(p_booking);
  v text := upper(regexp_replace(trim(coalesce(p_reg, '')), '\s+', ' ', 'g'));
begin
  -- The office can correct any reg; the drivers only fill in a missing one.
  if not (can('import') or (can('intake') and b.reg = '')) then raise exception 'Only the office can change a reg.'; end if;
  if length(v) > 12 or v !~ '^[A-Z0-9 ]*$' then raise exception 'Check the reg: letters and numbers only.'; end if;
  if v = b.reg then return b; end if;
  update bookings set reg = v, updated_at = now() where id = b.id returning * into b;
  -- The same booking's other row (PICKS / DROPS share the ref) gets it too, if it has none.
  if v <> '' and b.ref <> '' then
    update bookings set reg = v, updated_at = now() where company_id = b.company_id and ref = b.ref and id <> b.id and reg = '';
  end if;
  perform log_activity(b, 'REG', coalesce(nullif(v, ''), '(cleared)'));
  return b;
end;
$$;
revoke execute on function set_reg(uuid, text) from public, anon;
grant execute on function set_reg(uuid, text) to authenticated;

create or replace function import_sheet(p_kind text, p_day date, p_rows jsonb, p_source jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s staff := me();
  c companies;
  sh sheets;
  r jsonb;
  added int := 0; updated int := 0; n_early int := 0; n_moved int := 0;
  next_num int;
  existing bookings;
  prior bookings;
  prior_day date;
  keep_flight boolean;
  new_ret timestamptz;
  new_drop timestamptz;
  reg_key text;
  extended boolean;
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
    new_ret := nullif(r->>'return_local', '')::timestamp at time zone c.time_zone;
    new_drop := nullif(r->>'drop_local', '')::timestamp at time zone c.time_zone;
    reg_key := upper(regexp_replace(coalesce(r->>'reg', ''), '\s', '', 'g'));

    select * into existing from bookings b
      where b.company_id = c.id and b.sheet_id = sh.id
        and ((b.ref <> '' and b.ref = coalesce(r->>'ref', ''))
          or (reg_key <> '' and (b.ref = '' or coalesce(r->>'ref', '') = '')
              and upper(regexp_replace(b.reg, '\s', '', 'g')) = reg_key))
      order by (b.ref <> '' and b.ref = coalesce(r->>'ref', '')) desc
      limit 1;

    -- Not on this sheet: the same car still here from an earlier DROPS day
    -- (booked back earlier, since changed to this day)?
    prior := null;
    if not found and p_kind = 'drops' and new_ret is not null then
      select b.* into prior from bookings b join sheets o on o.id = b.sheet_id
        where b.company_id = c.id and b.kind = 'drops' and o.kind = 'drops'
          and o.day < p_day and o.day >= p_day - 60
          and b.cleared_at is null and b.removed_at is null and not b.early
          and b.return_at is not null and new_ret > b.return_at
          and ((b.ref <> '' and b.ref = coalesce(r->>'ref', ''))
            or (reg_key <> '' and (b.ref = '' or coalesce(r->>'ref', '') = '')
                and upper(regexp_replace(b.reg, '\s', '', 'g')) = reg_key
                -- the same stay, not a new booking after it
                and coalesce(new_drop, b.drop_at, b.return_at) <= b.return_at))
        order by o.day desc
        limit 1;
      if prior.id is not null then
        select day into prior_day from sheets where id = prior.sheet_id;
        next_num := next_num + 1;
        keep_flight := exists (select 1 from activity where booking_id = prior.id and action = 'FLIGHT');
        if keep_flight then r := r - 'flight'; end if;
        update bookings set
          sheet_id = sh.id, num = next_num,
          orig_return_at = coalesce(orig_return_at, return_at),
          return_at = new_ret,
          -- booked for this day now: out of the overstay block
          overstay = false,
          called_word = case when called_word = 'Overstay' then '' else called_word end,
          called_at = case when called_word = 'Overstay' then null else called_at end,
          called_by = case when called_word = 'Overstay' then null else called_by end,
          ref = case when ref = '' then coalesce(r->>'ref', '') else ref end,
          reg = case when reg = '' then coalesce(r->>'reg', '') else reg end,
          name = coalesce(nullif(r->>'name', ''), name), phone = coalesce(nullif(r->>'phone', ''), phone),
          make = coalesce(nullif(r->>'make', ''), make),
          drop_at = coalesce(new_drop, drop_at),
          sched_at = case when coalesce(r->>'flight', '') not in ('', flight) then null else sched_at end,
          sched_time = case when coalesce(r->>'flight', '') not in ('', flight) then '' else sched_time end,
          est_at = null, est_time = '', flight_status = '', flight_note = '',
          flight = case when coalesce(r->>'flight', '') <> '' then r->>'flight' else flight end,
          note = case when note = '' then left(coalesce(r->>'note', ''), 500) else note end,
          updated_at = now()
        where id = prior.id returning * into prior;
        insert into activity(company_id, staff_id, staff_name, sheet_id, booking_id, reg, customer, action, value)
        values (c.id, s.id, s.name, sh.id, prior.id, prior.reg, prior.name, 'RETURN CHANGED',
          'was ' || to_char(prior.orig_return_at at time zone c.time_zone, 'DD Mon HH24:MI') || ', now ' ||
          to_char(prior.return_at at time zone c.time_zone, 'DD Mon HH24:MI') || ' (moved from ' || to_char(prior_day, 'DD Mon') || ')');
        n_moved := n_moved + 1;
        continue;
      end if;
    end if;

    if existing.id is not null then
      -- Carried here as an overstay, and the file now books it back on this
      -- day or later: it's booked for this day now, out of the overstay block.
      extended := p_kind = 'drops' and not existing.early and existing.return_at is not null and new_ret is not null
        and new_ret > existing.return_at and (new_ret at time zone c.time_zone)::date >= p_day;
      -- A flight number the office typed in (logged as FLIGHT) wins over the
      -- file's: it was usually typed because the file's was wrong.
      keep_flight := exists (select 1 from activity where booking_id = existing.id and action = 'FLIGHT');
      if keep_flight then r := r - 'flight'; end if;
      -- A changed flight number forgets the times found for the old one.
      update bookings set
        ref = case when ref = '' then coalesce(r->>'ref', '') else ref end,
        -- A blank in the file never wipes what's there (e.g. a reg typed in when the car came).
        reg = coalesce(nullif(r->>'reg', ''), reg), name = coalesce(nullif(r->>'name', ''), name),
        phone = coalesce(nullif(r->>'phone', ''), phone), make = coalesce(nullif(r->>'make', ''), make),
        drop_at = coalesce(new_drop, drop_at),
        -- Moved to a later day: remember the first booked return (the charge counts from it).
        orig_return_at = case
          when new_ret is null or return_at is null then orig_return_at
          when (new_ret at time zone c.time_zone)::date <= (coalesce(orig_return_at, return_at) at time zone c.time_zone)::date then null
          when (new_ret at time zone c.time_zone)::date > (return_at at time zone c.time_zone)::date then coalesce(orig_return_at, return_at)
          else orig_return_at end,
        return_at = coalesce(new_ret, return_at),
        overstay = case when extended then false else overstay end,
        called_word = case when extended and called_word = 'Overstay' then '' else called_word end,
        called_at = case when extended and called_word = 'Overstay' then null else called_at end,
        called_by = case when extended and called_word = 'Overstay' then null else called_by end,
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
      values (c.id, sh.id, p_kind, coalesce(r->>'ref', ''),
        -- no reg in the file: the one typed in on the booking's other row, if any
        coalesce(nullif(r->>'reg', ''), (select x.reg from bookings x where x.company_id = c.id and x.ref <> '' and x.ref = r->>'ref' and x.reg <> '' limit 1), ''),
        coalesce(r->>'name', ''),
        coalesce(r->>'phone', ''), coalesce(r->>'make', ''), new_drop, new_ret,
        coalesce(r->>'flight', ''), left(coalesce(r->>'note', ''), 500), next_num);
      added := added + 1;
    end if;
  end loop;

  insert into activity(company_id, staff_id, staff_name, sheet_id, action, value)
  values (c.id, s.id, s.name, sh.id, 'IMPORT', p_kind || ' ' || p_day || ': ' || added || ' added, ' || updated || ' updated'
    || case when n_moved > 0 then ', ' || n_moved || ' moved here from an earlier day (return changed)' else '' end
    || case when n_early > 0 then ', ' || n_early || ' early return(s) left where they are' else '' end);

  return jsonb_build_object('sheet_id', sh.id, 'added', added, 'updated', updated, 'early', n_early, 'moved', n_moved);
end;
$$;
revoke execute on function import_sheet(text, date, jsonb, jsonb) from public, anon;
grant execute on function import_sheet(text, date, jsonb, jsonb) to authenticated;
