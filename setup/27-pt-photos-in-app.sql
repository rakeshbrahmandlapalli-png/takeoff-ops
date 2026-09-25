-- Parking Ops — database part 27: see a car's PT photos in the app.
--
-- Every PT keeps a copy of its photos for 30 days (part 25's store), whichever
-- way they went to PT. The car's panel lists them; View opens the same photo
-- page PT gets with the link. Any staff of the company can see them.
-- Safe to run twice.

create or replace function pt_photos_for(p_booking uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('token', l.token, 'n', cardinality(l.paths), 'at', l.created_at,
                                               'by', coalesce(st.name, ''), 'expires', l.expires_at) order by l.created_at desc), '[]'::jsonb)
  from pt_links l left join staff st on st.id = l.created_by
  where l.booking_id = p_booking and l.company_id = my_company() and l.expires_at > now() and cardinality(l.paths) > 0
$$;
revoke execute on function pt_photos_for(uuid) from public, anon;
grant execute on function pt_photos_for(uuid) to authenticated;
