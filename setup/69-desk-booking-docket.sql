-- Parking Ops — database part 69: a new booking at the desk, with a photo of the docket.
--
-- PICKS → "+ New booking": anyone who takes cars in (everyone but view-only)
-- adds a car made at the desk. It's marked NEW BOOKING, taken in (COLL) if
-- ticked, given its location if the client uses Location on PICKS, and the
-- docket can be photographed and kept with the car for 90 days.
--   • add_booking: as part 15, plus desk bookings on PICKS for anyone who
--     can take cars in (office and managers still add to any sheet).
--   • bookings.doc_path / doc_at: the docket photo, in the private pt-photos
--     bucket at <company>/docs/<booking>/<time>.jpg. set_doc() records it;
--     staff of the company can view it (signed link), nobody else.
--   • pt_links_expired: as part 59, but docket photos are no longer swept up
--     as stray PT photos after a day; they go after 90 days.
-- Safe to run twice. Needs parts 15, 25 and 59 first.

alter table bookings add column if not exists doc_path text not null default '';
alter table bookings add column if not exists doc_at   timestamptz;

create or replace function add_booking(p_sheet uuid, p jsonb)
returns bookings language plpgsql security definer set search_path = public as $$
declare
  s staff := me();
  c companies;
  sh sheets;
  b bookings;
  reg text := upper(regexp_replace(trim(coalesce(p->>'reg', '')), '\s+', ' ', 'g'));
  y text := upper(trim(coalesce(p->>'yard', '')));
begin
  select * into sh from sheets where id = p_sheet and company_id = my_company();
  if not found then raise exception 'That sheet is not on your board.'; end if;
  -- The office adds to any sheet; anyone who takes cars in adds desk bookings to PICKS.
  if not (can('import') or (sh.kind = 'picks' and can('intake'))) then raise exception 'Only the office can add cars.'; end if;
  select * into c from companies where id = sh.company_id;
  if reg = '' then raise exception 'Enter the registration.'; end if;
  if y <> '' and not (y = any(c.yards)) then raise exception 'Not a valid yard: %', y; end if;

  insert into bookings(company_id, sheet_id, kind, ref, reg, name, phone, make, drop_at, return_at, flight, yard, note, num)
  values (c.id, sh.id, sh.kind, left(trim(coalesce(p->>'ref', '')), 40), left(reg, 12),
    left(trim(coalesce(p->>'name', '')), 80), left(trim(coalesce(p->>'phone', '')), 30), left(trim(coalesce(p->>'make', '')), 60),
    nullif(p->>'drop_local', '')::timestamp at time zone c.time_zone,
    nullif(p->>'return_local', '')::timestamp at time zone c.time_zone,
    left(upper(trim(coalesce(p->>'flight', ''))), 12), case when sh.kind = 'drops' then y else '' end,
    left(trim(coalesce(p->>'note', '')), 500),
    (select coalesce(max(num), 0) + 1 from bookings where sheet_id = sh.id))
  returning * into b;
  perform log_activity(b, 'ADDED', case when p->>'desk' = 'true' then 'new booking at the desk' else 'added by hand' end);
  -- A desk booking on PICKS: marked NEW BOOKING, taken in now if ticked, its location if given.
  if sh.kind = 'picks' and p->>'desk' = 'true' then
    update bookings set pick_called = 'New Booking', pick_called_at = now(),
      intake = case when p->>'taken_in' = 'true' then 'Collected' else intake end,
      intake_at = case when p->>'taken_in' = 'true' then now() else intake_at end,
      intake_by = case when p->>'taken_in' = 'true' then s.id else intake_by end,
      yard = case when y <> '' and y = any(c.yards) then y else yard end,
      updated_at = now()
    where id = b.id returning * into b;
  end if;
  return b;
end;
$$;
revoke execute on function add_booking(uuid, jsonb) from public, anon;
grant execute on function add_booking(uuid, jsonb) to authenticated;

create or replace function set_doc(p_booking uuid, p_path text)
returns bookings language plpgsql security definer set search_path = public as $$
declare
  b bookings := booking_for_update(p_booking);
  path text := coalesce(p_path, '');
begin
  if not can('intake') then raise exception 'Not allowed for your role.'; end if;
  if path <> '' and path !~ ('^' || b.company_id::text || '/docs/' || b.id::text || '/[0-9]+\.jpg$') then raise exception 'That photo is not this car''s.'; end if;
  update bookings set doc_path = path, doc_at = case when path = '' then null else now() end, updated_at = now()
  where id = b.id returning * into b;
  perform log_activity(b, 'DOCKET', case when path = '' then 'photo removed' else 'photo taken' end);
  return b;
end;
$$;
revoke execute on function set_doc(uuid, text) from public, anon;
grant execute on function set_doc(uuid, text) to authenticated;

-- Staff can look at their own company's docket photos (the app asks for a signed link).
drop policy if exists docket_photos_read on storage.objects;
create policy docket_photos_read on storage.objects for select to authenticated
  using (bucket_id = 'pt-photos' and (storage.foldername(name))[1] = my_company()::text and (storage.foldername(name))[2] = 'docs');

create or replace function pt_links_expired()
returns table(token text, paths text[]) language sql stable security definer set search_path = public as $$
  with sized as (
    select l.token, array(select p from unnest(l.paths) p where p not like 'r2:%') as paths, l.expires_at, l.created_at,
      coalesce((select sum((o.metadata->>'size')::bigint) from storage.objects o
                where o.bucket_id = 'pt-photos' and o.name = any(l.paths)), 0) as bytes
    from pt_links l
  ), ranked as (
    select *, sum(bytes) over (order by created_at desc, token rows unbounded preceding) as kept
    from sized
  )
  (select token, paths from ranked
    where expires_at <= now() or (bytes > 0 and kept > 50::bigint * 1024 * 1024 * 1024)
    order by created_at limit 300)
  union all
  (select '', array_agg(o.name) from storage.objects o
    where o.bucket_id = 'pt-photos' and o.created_at < now() - interval '1 day'
      and split_part(o.name, '/', 2) <> 'docs'
      and not exists (select 1 from pt_links l where o.name = any(l.paths))
    group by split_part(o.name, '/', 3)
    limit 100)
  union all
  -- Docket photos (part 69): kept 90 days.
  (select '', array_agg(o.name) from storage.objects o
    where o.bucket_id = 'pt-photos' and split_part(o.name, '/', 2) = 'docs' and o.created_at < now() - interval '90 days'
    group by split_part(o.name, '/', 1)
    limit 50)
$$;
revoke execute on function pt_links_expired() from public, anon, authenticated;
grant execute on function pt_links_expired() to service_role;
