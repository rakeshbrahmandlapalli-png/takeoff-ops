-- ════════════════════════════════════════════════════════════════════════
--  TAKEOFF OPS — part 5: archive and data retention
--
--  Run after part 3 (part 4 is not needed first). Safe to run again.
--
--  Nothing here hides or deletes a day sheet. Old days stay in the database
--  and the office finds them on the Archive screen. What this adds:
--
--    • How long customer details are kept: 12 months (TAKEOFF's choice,
--      17 Sep 2026; it should match the DPA). After that, every booking on a
--      sheet older than that loses the customer's name, phone number and any
--      note, and the activity log loses the name and note text. Reg, times,
--      flights, yards, every tap and who made it all stay, so counts and
--      history still add up.
--    • A daily timer (03:30) that does the wiping and clears out old
--      housekeeping rows (flight check records after 60 days, sent-alert
--      records after 45 days).
-- ════════════════════════════════════════════════════════════════════════
begin;

alter table companies add column if not exists keep_personal_months integer not null default 12
  check (keep_personal_months between 1 and 72);
alter table bookings add column if not exists personal_wiped_at timestamptz;

create or replace function wipe_old_personal(p_company uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  c companies;
  cutoff date;
  n integer;
begin
  select * into c from companies where id = p_company;
  if not found then return 0; end if;
  cutoff := ((now() at time zone c.time_zone)::date - make_interval(months => c.keep_personal_months))::date;

  update bookings b set name = '', phone = '', note = '', personal_wiped_at = now()
  from sheets s
  where b.sheet_id = s.id and s.company_id = c.id and s.day < cutoff
    and b.personal_wiped_at is null
    -- a car still out (an overstay never handed back) keeps its details
    and (b.kind = 'picks' or b.cleared_at is not null);
  get diagnostics n = row_count;

  update activity a set customer = '', value = case when a.action = 'NOTE' then '(removed)' else a.value end
  where a.company_id = c.id and a.at < (cutoff::timestamp at time zone c.time_zone)
    and (a.customer <> '' or (a.action = 'NOTE' and a.value <> '(removed)'));

  if n > 0 then
    insert into activity(company_id, staff_name, action, value)
    values (c.id, 'System', 'RETENTION', 'Customer details removed from ' || n || ' booking(s) before ' || to_char(cutoff, 'DD Mon YYYY'));
  end if;
  return n;
end;
$$;
revoke execute on function wipe_old_personal(uuid) from public, anon, authenticated;

create or replace function daily_housekeeping()
returns void language plpgsql security definer set search_path = public as $$
begin
  perform wipe_old_personal(id) from companies;
  delete from flight_runs where at < now() - interval '60 days';
  if to_regclass('public.alert_log') is not null then
    execute 'delete from alert_log where sent_at < now() - interval ''45 days''';
  end if;
end;
$$;
revoke execute on function daily_housekeeping() from public, anon, authenticated;

-- 02:30 UTC = 03:30 in summer, 02:30 in winter: quiet either way.
select cron.schedule('takeoff-housekeeping', '30 2 * * *', $job$ select public.daily_housekeeping() $job$);

commit;
