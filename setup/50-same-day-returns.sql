-- Parking Ops — database part 50: a new PICKS car that comes back the same day
-- goes on the DROPS sheet too (when the office says so).
--
-- The DROPS file for a day is often imported before a late booking is made.
-- A car added to PICKS after that (a re-import marks it NEW BOOKING, or it's
-- added by hand) and booked back on a day whose DROPS sheet is already in
-- would be missing from DROPS. The app now asks and adds it:
--   • import_sheet (part 44's wrapper) also returns added_ids, the cars it added.
--   • drops_missing(ids): of those PICKS cars, the ones booked back on a DROPS
--     day whose sheet exists, with no car of the same ref or reg on it.
--   • add_pick_to_drops(id): puts the car on that DROPS sheet (name, phone,
--     car, ref, times; the office adds the flight). When that day's file is
--     imported again the same car is matched by ref or reg, not added twice.
-- Safe to run twice.

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

  res := import_sheet_core(p_kind, p_day, p_rows, p_source);

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
create or replace function drops_day_of(p_at timestamptz, c companies)
returns date language sql stable as $$
  select (p_at at time zone c.time_zone)::date - case when (p_at at time zone c.time_zone)::time <= c.drops_day_end then 1 else 0 end
$$;
revoke execute on function drops_day_of(timestamptz, companies) from public, anon, authenticated;

create or replace function drops_missing(p_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  c companies;
begin
  if not can('import') then return '[]'; end if;
  select * into c from companies where id = my_company();
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', b.id, 'reg', b.reg, 'name', b.name, 'return_at', b.return_at, 'day', d.day, 'sheet_id', d.id) order by b.return_at)
    from bookings b
    join sheets d on d.company_id = c.id and d.kind = 'drops' and d.day = drops_day_of(b.return_at, c)
    where b.id = any(coalesce(p_ids, '{}')) and b.company_id = c.id and b.kind = 'picks'
      and b.removed_at is null and b.return_at is not null
      and not exists (select 1 from bookings x where x.sheet_id = d.id and x.removed_at is null
        and ((b.ref <> '' and x.ref = b.ref)
          or (b.reg <> '' and upper(regexp_replace(x.reg, '\s', '', 'g')) = upper(regexp_replace(b.reg, '\s', '', 'g')))))
  ), '[]');
end;
$$;
revoke execute on function drops_missing(uuid[]) from public, anon;
grant execute on function drops_missing(uuid[]) to authenticated;

create or replace function add_pick_to_drops(p_booking uuid)
returns bookings language plpgsql security definer set search_path = public as $$
declare
  p bookings;
  c companies;
  d sheets;
  b bookings;
begin
  if not can('import') then raise exception 'Only the office can add cars.'; end if;
  select * into p from bookings where id = p_booking and company_id = my_company();
  if not found or p.kind <> 'picks' then raise exception 'That car is not on a PICKS sheet.'; end if;
  if p.return_at is null then raise exception 'This car has no return date.'; end if;
  select * into c from companies where id = p.company_id;
  select * into d from sheets where company_id = c.id and kind = 'drops' and day = drops_day_of(p.return_at, c);
  if not found then raise exception 'There is no DROPS sheet for % yet: it comes with that day''s file.', to_char(drops_day_of(p.return_at, c), 'DD Mon'); end if;
  select * into b from bookings x where x.sheet_id = d.id and x.removed_at is null
    and ((p.ref <> '' and x.ref = p.ref)
      or (p.reg <> '' and upper(regexp_replace(x.reg, '\s', '', 'g')) = upper(regexp_replace(p.reg, '\s', '', 'g'))))
    limit 1;
  if found then return b; end if;
  insert into bookings(company_id, sheet_id, kind, ref, reg, name, phone, make, drop_at, return_at, num)
  values (c.id, d.id, 'drops', p.ref, p.reg, p.name, p.phone, p.make, p.drop_at, p.return_at,
    (select coalesce(max(num), 0) + 1 from bookings where sheet_id = d.id))
  returning * into b;
  perform log_activity(b, 'ADDED', 'from PICKS: new booking, back ' || to_char(p.return_at at time zone c.time_zone, 'DD Mon HH24:MI'));
  return b;
end;
$$;
revoke execute on function add_pick_to_drops(uuid) from public, anon;
grant execute on function add_pick_to_drops(uuid) to authenticated;
