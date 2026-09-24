--  TAKEOFF OPS — part 13: let the sign-in screen know whose app it is
--
--  Before anyone signs in there is no company, so every screen wore the first
--  customer's name: an Airport Parking Bay driver opened their own app and was
--  greeted by "TakeOff".
--
--  This exposes ONLY a company's display name and its brand (colour, short
--  name, logo) to a caller who is not signed in, looked up by the slug in the
--  address or by the host the app is being served from. No staff, no bookings,
--  no customers — nothing here is private, it is the name over the door.

create or replace function public_brand(p_key text)
returns jsonb language sql security definer stable set search_path = public as $$
  select jsonb_build_object('name', c.name, 'brand', coalesce(c.brand, '{}'::jsonb))
  from companies c
  where c.slug = lower(trim(p_key)) or c.brand->>'host' = lower(trim(p_key))
  limit 1;
$$;

revoke execute on function public_brand(text) from public;
grant execute on function public_brand(text) to anon, authenticated;

-- Each company can own an address, so the app knows who it belongs to before a
-- word is typed. TakeOff keeps the original; Airport Parking Bay has its own.
update companies set brand = coalesce(brand, '{}'::jsonb) || jsonb_build_object('host', 'takeoff-ops.vercel.app')
where slug = 'takeoff';

update companies set brand = coalesce(brand, '{}'::jsonb) || jsonb_build_object('host', 'parkingbay-ops.vercel.app')
where slug = 'airport-parking-bay';

-- Check: each should return its own name and colour.
select public_brand('parkingbay-ops.vercel.app') as by_host,
       public_brand('airport-parking-bay')       as by_slug,
       public_brand('takeoff')                   as takeoff;
