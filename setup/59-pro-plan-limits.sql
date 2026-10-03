-- Parking Ops — database part 59: the Pro plan's room (3 Oct 2026).
--
-- The project moved to Supabase Pro (8 GB database, 100 GB file store). The
-- free-plan squeeze from parts 35 and 43 is relaxed:
--   • PT copies in Supabase's own store are kept 30 days, not 3 (the same as
--     the Cloudflare copies); links already saved get the extra days too;
--   • the store's safety cap goes from 850 MB to 50 GB (oldest sets go first
--     past that, so a runaway can never fill the plan);
--   • the morning usage warning uses Pro's limits.
-- Unsaved photos still go after a day. Safe to run twice.

alter table pt_links alter column expires_at set default now() + interval '30 days';
update pt_links set expires_at = greatest(expires_at, created_at + interval '30 days')
where expires_at > now();

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
  -- 30 days wherever the copies are (Supabase's store was 3 days on the free plan).
  insert into pt_links(token, company_id, booking_id, reg, paths, created_by, expires_at)
  values (p_token, s.company_id, b.id, b.reg, coalesce(p_paths, '{}'), s.id, now() + interval '30 days')
  on conflict (token) do update
    set paths = (select array_agg(distinct x order by x) from unnest(pt_links.paths || excluded.paths) x),
        expires_at = greatest(pt_links.expires_at, excluded.expires_at);
  insert into activity(company_id, staff_id, staff_name, sheet_id, booking_id, reg, customer, action, value)
  values (s.company_id, s.id, s.name, b.sheet_id, b.id, b.reg, b.name, 'PT PHOTOS',
          cardinality(coalesce(p_paths, '{}')) || ' photos uploaded' || case when in_r2 then ' (Cloudflare)' else '' end);
  return p_token;
end;
$$;

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
      and not exists (select 1 from pt_links l where o.name = any(l.paths))
    group by split_part(o.name, '/', 3)
    limit 100)
$$;

create or replace function usage_status()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  db_mb numeric := round(pg_database_size(current_database()) / 1048576.0, 1);
  photo_mb numeric := round(coalesce((select sum((metadata->>'size')::bigint) from storage.objects where bucket_id = 'pt-photos'), 0) / 1048576.0, 1);
  last_backup timestamptz := (select max(taken_at) from private.backups);
  warnings text[] := '{}';
begin
  -- Pro: 8 GB database, 100 GB files (the clean-up keeps photos under 50 GB).
  if db_mb > 6000 then warnings := warnings || ('Database is ' || db_mb || ' MB of the 8 GB on Pro.'); end if;
  if photo_mb > 55000 then warnings := warnings || ('PT photo store is ' || photo_mb || ' MB: past the 50 GB the clean-up keeps it under, so it may have stopped.'); end if;
  if last_backup is null or last_backup < now() - interval '30 hours' then
    warnings := warnings || ('No nightly backup since ' || coalesce(to_char(last_backup at time zone 'Europe/London', 'DD Mon HH24:MI'), 'ever') || '.');
  end if;
  return jsonb_build_object('db_mb', db_mb, 'photo_mb', photo_mb, 'last_backup', last_backup, 'warnings', to_jsonb(warnings),
    'to', string_to_array((select value from private.settings where name = 'usage_alert_to'), ','));
end $$;

-- Check: new links keep 30 days; the cap and warnings follow Pro.
select (select column_default from information_schema.columns where table_name = 'pt_links' and column_name = 'expires_at') as link_default,
       usage_status() as usage;
