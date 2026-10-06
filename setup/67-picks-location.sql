-- Parking Ops — database part 67: location (yard) on PICKS, switched per client.
--
-- Parking Ops → Clients → Edit → "Location on PICKS". When it's on, that
-- client's PICKS rows show a location button (their yards, e.g. GS / MY / T)
-- where NO SHOW was; NO SHOW moves into the car's panel, and the numbers at
-- the top count cars per yard. Stored as brand.picks_yard (true, or absent).
--   • admin_save_client: as part 65, plus picks_yard (removed when unticked).
--   • set_yard: on a PICKS car, anyone who can take cars in (terminal, bongo,
--     office…) may set the location; DROPS stay office / manager as before.
-- Nobody is switched on by running this. Safe to run twice. Needs part 65.

create or replace function admin_save_client(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c companies;
  y text;
  ys text[] := coalesce((select array_agg(upper(trim(v))) from jsonb_array_elements_text(coalesce(p->'yards', '[]')) v where trim(v) <> ''), '{}');
  b jsonb := coalesce(p->'brand', '{}');
  k text;
  -- The form always sends the look; an older app that doesn't leaves it alone.
  set_look boolean := coalesce(p->'brand', '{}') ? 'theme';
  -- Same for the PICKS location switch: an older form leaves it alone.
  set_py boolean := coalesce(p->'brand', '{}') ? 'picks_yard';
begin
  if not is_platform_admin() then raise exception 'Not allowed.'; end if;
  if coalesce(trim(p->>'name'), '') = '' then raise exception 'Enter the client''s name.'; end if;
  if array_length(ys, 1) is null then raise exception 'Enter at least one yard.'; end if;
  foreach y in array ys loop
    if y !~ '^[A-Z0-9]{1,4}$' then raise exception 'Yard codes are 1 to 4 letters or numbers: %', y; end if;
  end loop;
  foreach k in array array['colour', 'ink', 'soft', 'text'] loop
    if coalesce(b->>k, '') <> '' and b->>k !~ '^#[0-9A-Fa-f]{6}$' then raise exception 'Colours look like #1560BD (%).', k; end if;
  end loop;
  if coalesce(b->>'host', '') <> '' and b->>'host' !~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$' then raise exception 'The address looks like clientname-ops.vercel.app'; end if;
  if coalesce(b->>'theme', '') not in ('', 'pro', 'cards', 'premium', 'board', 'stdplus') then raise exception 'Unknown look: %', b->>'theme'; end if;
  b := jsonb_strip_nulls(jsonb_build_object('name', trim(p->>'name'), 'short', nullif(trim(b->>'short'), ''),
    'colour', nullif(b->>'colour', ''), 'ink', nullif(b->>'ink', ''), 'soft', nullif(b->>'soft', ''), 'text', nullif(b->>'text', ''),
    'host', nullif(lower(b->>'host'), ''), 'logo', nullif(b->>'logo', ''), 'theme', nullif(b->>'theme', ''),
    'picks_yard', case when coalesce(b->>'picks_yard', '') = 'true' then true end));

  if coalesce(p->>'id', '') = '' then
    if coalesce(p->>'slug', '') !~ '^[a-z0-9][a-z0-9-]{1,39}$' then raise exception 'The short code is lower-case letters, numbers and dashes, like airport-parking-bay.'; end if;
    if p->>'slug' = 'platform' then raise exception 'That short code is taken.'; end if;
    if exists (select 1 from companies where slug = p->>'slug') then raise exception 'That short code is taken.'; end if;
    insert into companies (name, slug, yards, drops_day_end, time_zone, brand)
    values (trim(p->>'name'), p->>'slug', ys, coalesce(nullif(p->>'drops_day_end', '')::time, '06:00'), 'Europe/London', b)
    returning * into c;
  else
    -- Standard drops the theme key: merging alone could never take it away.
    update companies set name = trim(p->>'name'), yards = ys,
      drops_day_end = coalesce(nullif(p->>'drops_day_end', '')::time, drops_day_end),
      brand = (case when set_look then brand - 'theme' else brand end) - (case when set_py then 'picks_yard' else '' end) || b
    where id = (p->>'id')::uuid and slug <> 'platform' returning * into c;
    if not found then raise exception 'Client not found.'; end if;
  end if;
  return to_jsonb(c);
end;
$$;

revoke execute on function admin_save_client(jsonb) from public, anon;
grant execute on function admin_save_client(jsonb) to authenticated;


create or replace function set_yard(p_booking uuid, p_yard text)
returns bookings language plpgsql security definer set search_path = public as $$
declare
  b bookings := booking_for_update(p_booking);
  y text := upper(trim(coalesce(p_yard, '')));
  yards text[];
begin
  if not (can('yard') or (b.kind = 'picks' and can('intake'))) then raise exception 'Not allowed for your role: yard'; end if;
  select c.yards into yards from companies c where c.id = b.company_id;
  if y <> '' and not (y = any(yards)) then raise exception 'Not a valid yard: %', y; end if;
  -- The office's choice always wins, including T for cars left at the
  -- terminal. Forget the pre-SENT yard so undoing SENT can't overwrite it.
  update bookings set yard = y, yard_before_t = '', updated_at = now() where id = b.id returning * into b;
  perform log_activity(b, 'YARD', coalesce(nullif(y, ''), '(cleared)'));
  return b;
end;
$$;
revoke execute on function set_yard(uuid, text) from public, anon;
grant execute on function set_yard(uuid, text) to authenticated;

-- Check: every client, its look and the PICKS location switch (none changes by running this).
select name, coalesce(brand->>'theme', 'standard') as look, coalesce(brand->>'picks_yard', 'off') as picks_location from companies order by name;
