-- Parking Ops — database part 46: the PT photo clean-up back to once an hour.
--
-- PT copies go to Cloudflare R2 now (part 43), so Supabase's photo store only
-- empties; the 15-minute run (part 41) was 96 function calls a day, each
-- adding to the free plan's log ingestion, for next to nothing to do. Once an
-- hour still deletes expired photos promptly and keeps the 850 MB cap.
-- Same job otherwise. Safe to run twice.

select cron.schedule('pt-photos-cleanup', '40 * * * *', $job$
  select net.http_post(
    url := 'https://oioqjfrlwrjovnouhusp.supabase.co/functions/v1/pt-photos',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-timer', (select value from private.settings where name = 'timer_secret')),
    body := '{"action":"cleanup"}'::jsonb,
    timeout_milliseconds := 120000)
$job$);
