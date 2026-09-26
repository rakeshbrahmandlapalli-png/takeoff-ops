-- Parking Ops — database part 41: the PT photo clean-up runs every 15 minutes
-- (was hourly), so the 850 MB cap (part 35) holds even while a phone is still
-- sending full-size copies. Same job as part 35 otherwise. Safe to run twice.

select cron.schedule('pt-photos-cleanup', '*/15 * * * *', $job$
  select net.http_post(
    url := 'https://oioqjfrlwrjovnouhusp.supabase.co/functions/v1/pt-photos',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-timer', (select value from private.settings where name = 'timer_secret')),
    body := '{"action":"cleanup"}'::jsonb,
    timeout_milliseconds := 120000)
$job$);
