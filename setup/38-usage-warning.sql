-- Parking Ops — database part 38: an early warning before a free-plan limit.
--
-- Every morning the database checks itself and, if something needs looking
-- at, the send-alerts function pushes a notification (and posts to Discord)
-- to the owners and managers of the companies named in private.settings
-- 'usage_alert_to' (comma-separated slugs; TAKEOFF runs the account):
--   • database over 350 MB (70% of the free 500 MB);
--   • PT photo store over 900 MB of the free 1 GB (the hourly clean-up keeps
--     it under 850 MB, so this means the clean-up has stopped working);
--   • no nightly backup in the last 30 hours.
-- Downloads (egress) and logs can't be seen from inside the database: those
-- stay a weekly look at Supabase → Usage. Safe to run twice.

insert into private.settings(name, value) values ('usage_alert_to', 'takeoff')
on conflict (name) do nothing;

create or replace function usage_status()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  db_mb numeric := round(pg_database_size(current_database()) / 1048576.0, 1);
  photo_mb numeric := round(coalesce((select sum((metadata->>'size')::bigint) from storage.objects where bucket_id = 'pt-photos'), 0) / 1048576.0, 1);
  last_backup timestamptz := (select max(taken_at) from private.backups);
  warnings text[] := '{}';
begin
  if db_mb > 350 then warnings := warnings || ('Database is ' || db_mb || ' MB of the free 500 MB.'); end if;
  if photo_mb > 900 then warnings := warnings || ('PT photo store is ' || photo_mb || ' MB of the free 1 GB: the hourly clean-up may have stopped.'); end if;
  if last_backup is null or last_backup < now() - interval '30 hours' then
    warnings := warnings || ('No nightly backup since ' || coalesce(to_char(last_backup at time zone 'Europe/London', 'DD Mon HH24:MI'), 'ever') || '.');
  end if;
  return jsonb_build_object('db_mb', db_mb, 'photo_mb', photo_mb, 'last_backup', last_backup, 'warnings', to_jsonb(warnings),
    'to', string_to_array((select value from private.settings where name = 'usage_alert_to'), ','));
end $$;
revoke execute on function usage_status() from public, anon, authenticated;
grant execute on function usage_status() to service_role;

-- 08:10 UTC every day (09:10 in summer, 08:10 in winter): after the night shift.
select cron.schedule('usage-warning', '10 8 * * *', $job$
  select net.http_post(
    url := 'https://oioqjfrlwrjovnouhusp.supabase.co/functions/v1/send-alerts',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-timer', (select value from private.settings where name = 'timer_secret')),
    body := '{"type":"usage"}'::jsonb,
    timeout_milliseconds := 60000)
$job$);
