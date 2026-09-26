-- Parking Ops — database part 35: PT photo copies fit the free plan.
--
-- Every PT keeps a copy of its photos (parts 25/27). About 30 photos a car and
-- 100-160 cars a night filled the free plan's 1 GB of file storage in one
-- night. Now:
--   • copies are kept 3 days, not 30 (the app also uploads them small);
--   • the store is capped at 850 MB: past that the oldest sets go first, so
--     a busy spell can never push the project over its quota;
--   • photos whose set was never saved (the phone gave up) go after a day;
--   • the clean-up runs every hour instead of once a night.
-- Safe to run twice.

alter table pt_links alter column expires_at set default now() + interval '3 days';
update pt_links set expires_at = least(expires_at, created_at + interval '3 days');

create or replace function pt_links_expired()
returns table(token text, paths text[]) language sql stable security definer set search_path = public as $$
  with sized as (
    select l.token, l.paths, l.expires_at, l.created_at,
      coalesce((select sum((o.metadata->>'size')::bigint) from storage.objects o
                where o.bucket_id = 'pt-photos' and o.name = any(l.paths)), 0) as bytes
    from pt_links l
  ), ranked as (
    select *, sum(bytes) over (order by created_at desc, token rows unbounded preceding) as kept
    from sized
  )
  (select token, paths from ranked
    where expires_at <= now() or kept > 850 * 1024 * 1024
    order by created_at limit 300)
  union all
  -- never saved as a set: no link to forget (''), just the files
  (select '', array_agg(o.name) from storage.objects o
    where o.bucket_id = 'pt-photos' and o.created_at < now() - interval '1 day'
      and not exists (select 1 from pt_links l where o.name = any(l.paths))
    group by split_part(o.name, '/', 3)
    limit 100)
$$;
revoke execute on function pt_links_expired() from public, anon, authenticated;
grant execute on function pt_links_expired() to service_role;

-- Every hour, so the cap is kept during a busy night too.
select cron.schedule('pt-photos-cleanup', '40 * * * *', $job$
  select net.http_post(
    url := 'https://oioqjfrlwrjovnouhusp.supabase.co/functions/v1/pt-photos',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-timer', (select value from private.settings where name = 'timer_secret')),
    body := '{"action":"cleanup"}'::jsonb,
    timeout_milliseconds := 120000)
$job$);
