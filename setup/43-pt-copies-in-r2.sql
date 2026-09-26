-- Parking Ops — database part 43: PT photo copies can live in Cloudflare R2.
--
--   • companies.pt_copy_store: 'supabase' (as before) or 'r2'. The switch for
--     where a company's copies go; flipping it back needs no app update.
--   • pt_link_save accepts R2 paths, written "r2:<company>/<booking>/<token>/NN.jpg"
--     (same folder check), and a set held in R2 is kept 30 days (R2 deletes
--     the files itself after 30 days: bucket lifecycle rule). Sets in
--     Supabase's store stay at 3 days (part 35).
--   • pt_links_expired never hands R2 paths to the Supabase clean-up (it only
--     forgets the expired link; R2 removes the files).
-- Safe to run twice.

alter table companies add column if not exists pt_copy_store text not null default 'supabase'
  check (pt_copy_store in ('supabase', 'r2'));

create or replace function pt_link_save(p_token text, p_booking uuid, p_paths text[])
returns text language plpgsql security definer set search_path = public as $$
declare
  s staff := me();
  b bookings;
  prefix text;
  l pt_links;
  in_r2 boolean;
begin
  if not can('intake') then raise exception 'Not allowed for your role: %', s.role; end if;
  select * into b from bookings where id = p_booking and company_id = s.company_id;
  if b.id is null then raise exception 'That car is not on your board.'; end if;
  if p_token !~ '^[A-Za-z0-9_-]{22,64}$' then raise exception 'Bad link.'; end if;
  prefix := s.company_id::text || '/' || b.id::text || '/' || p_token || '/';
  if exists (select 1 from unnest(coalesce(p_paths, '{}')) p
             where left(regexp_replace(p, '^r2:', ''), length(prefix)) <> prefix or p like '%..%') then
    raise exception 'Those photos are not in this link''s folder.';
  end if;
  in_r2 := exists (select 1 from unnest(coalesce(p_paths, '{}')) p where p like 'r2:%');
  select * into l from pt_links where token = p_token;
  if l.token is not null and (l.company_id <> s.company_id or l.booking_id is distinct from b.id) then raise exception 'Bad link.'; end if;
  insert into pt_links(token, company_id, booking_id, reg, paths, created_by, expires_at)
  values (p_token, s.company_id, b.id, b.reg, coalesce(p_paths, '{}'), s.id,
          now() + case when in_r2 then interval '30 days' else interval '3 days' end)
  on conflict (token) do update
    set paths = (select array_agg(distinct x order by x) from unnest(pt_links.paths || excluded.paths) x),
        expires_at = greatest(pt_links.expires_at, excluded.expires_at);
  insert into activity(company_id, staff_id, staff_name, sheet_id, booking_id, reg, customer, action, value)
  values (s.company_id, s.id, s.name, b.sheet_id, b.id, b.reg, b.name, 'PT PHOTOS',
          cardinality(coalesce(p_paths, '{}')) || ' photos uploaded' || case when in_r2 then ' (Cloudflare)' else '' end);
  return p_token;
end;
$$;
revoke execute on function pt_link_save(text, uuid, text[]) from public, anon;
grant execute on function pt_link_save(text, uuid, text[]) to authenticated;

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
    where expires_at <= now() or (bytes > 0 and kept > 850 * 1024 * 1024)
    order by created_at limit 300)
  union all
  (select '', array_agg(o.name) from storage.objects o
    where o.bucket_id = 'pt-photos' and o.created_at < now() - interval '1 day'
      and not exists (select 1 from pt_links l where o.name = any(l.paths))
    group by split_part(o.name, '/', 3)
    limit 100)
$$;
revoke execute on function pt_links_expired() from public, anon, authenticated;
grant execute on function pt_links_expired() to service_role;
