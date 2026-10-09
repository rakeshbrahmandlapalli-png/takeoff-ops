-- Parking Ops — database part 75: the exit fee, and the bookings that don't pay it.
--
-- Parking Ops → Clients → Edit gets EXIT FEE (£, e.g. 10 for Airport Parking
-- Bay) and NO EXIT FEE FOR REFERENCES STARTING WITH (e.g. CAP, FHR, or whole
-- references). The app compares references by letters and numbers only, any
-- case, so "CPD - 19-660374" and "Cpd 19660209" both start with CPD.
--   • admin_save_client: as part 72, plus brand.exit_fee (0 to 999) and
--     brand.exit_free (up to 200 starts, letters and numbers, upper case).
-- Nothing changes for a client until an exit fee is entered. Safe to run
-- twice. Needs part 72.

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
  -- And the exit fee: an older form leaves the fee and its free list alone.
  set_xf boolean := coalesce(p->'brand', '{}') ? 'exit_fee';
  xfee numeric := nullif(trim(coalesce(p->'brand'->>'exit_fee', '')), '')::numeric;
  xfree jsonb := coalesce((select jsonb_agg(distinct v) from (
    select upper(regexp_replace(e, '[^A-Za-z0-9]', '', 'g')) v
    from jsonb_array_elements_text(case when jsonb_typeof(p->'brand'->'exit_free') = 'array' then p->'brand'->'exit_free' else '[]' end) e) x
    where v <> ''), '[]');
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
  if coalesce(b->>'theme', '') not in ('', 'pro', 'cards', 'premium', 'board', 'stdplus', 'ops') then raise exception 'Unknown look: %', b->>'theme'; end if;
  if xfee is not null and (xfee < 0 or xfee > 999) then raise exception 'The exit fee is £0 to £999.'; end if;
  if jsonb_array_length(xfree) > 200 then raise exception 'Up to 200 references without the exit fee.'; end if;
  if exists (select 1 from jsonb_array_elements_text(xfree) v where length(v) > 40) then raise exception 'A reference is 40 letters or numbers at most.'; end if;
  b := jsonb_strip_nulls(jsonb_build_object('name', trim(p->>'name'), 'short', nullif(trim(b->>'short'), ''),
    'colour', nullif(b->>'colour', ''), 'ink', nullif(b->>'ink', ''), 'soft', nullif(b->>'soft', ''), 'text', nullif(b->>'text', ''),
    'host', nullif(lower(b->>'host'), ''), 'logo', nullif(b->>'logo', ''), 'theme', nullif(b->>'theme', ''),
    'picks_yard', case when coalesce(b->>'picks_yard', '') = 'true' then true end,
    'exit_fee', case when xfee > 0 then round(xfee, 2) end,
    'exit_free', case when xfee > 0 and jsonb_array_length(xfree) > 0 then xfree end));

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
      brand = (case when set_look then brand - 'theme' else brand end) - (case when set_py then 'picks_yard' else '' end)
        - (case when set_xf then 'exit_fee' else '' end) - (case when set_xf then 'exit_free' else '' end) || b
    where id = (p->>'id')::uuid and slug <> 'platform' returning * into c;
    if not found then raise exception 'Client not found.'; end if;
  end if;
  return to_jsonb(c);
end;
$$;

revoke execute on function admin_save_client(jsonb) from public, anon;
grant execute on function admin_save_client(jsonb) to authenticated;
