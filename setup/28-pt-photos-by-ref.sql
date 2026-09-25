-- Parking Ops — database part 28: a car's PT photos on its DROPS row too.
--
-- PT photos are taken on the PICKS sheet when the car comes in. The same
-- booking comes back on a DROPS sheet as a different row, so the photos are
-- found by booking ref as well: whoever hands the car back can check them.
-- Replaces pt_photos_for from part 27. Safe to run twice.

create or replace function pt_photos_for(p_booking uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  with me_b as (select id, ref from bookings where id = p_booking and company_id = my_company())
  select coalesce(jsonb_agg(jsonb_build_object('token', l.token, 'n', cardinality(l.paths), 'at', l.created_at,
                                               'by', coalesce(st.name, ''), 'expires', l.expires_at) order by l.created_at desc), '[]'::jsonb)
  from pt_links l
  join bookings b on b.id = l.booking_id
  join me_b on b.id = me_b.id or (coalesce(me_b.ref, '') <> '' and b.ref = me_b.ref)
  left join staff st on st.id = l.created_by
  where l.company_id = my_company() and b.company_id = my_company() and l.expires_at > now() and cardinality(l.paths) > 0
$$;
revoke execute on function pt_photos_for(uuid) from public, anon;
grant execute on function pt_photos_for(uuid) to authenticated;
