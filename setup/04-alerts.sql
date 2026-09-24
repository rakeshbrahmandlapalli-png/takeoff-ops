-- ════════════════════════════════════════════════════════════════════════
--  TAKEOFF OPS — part 4: alerts (phone notifications + Discord)
--
--  Run after part 3. Safe to run again.
--
--  The same alerts the Google Sheet sends, plus cancelled flights:
--    DROPS  CALLED or OVERSTAY on a car no driver has been SENT to yet
--           COMPLAINT (always)
--           Flight CANCELLED on a car not yet handed back
--    PICKS  RTC
--
--  How it fits together:
--    • A trigger on bookings spots those changes and hands the booking id to
--      the send-alerts Edge Function (through pg_net, after the tap is saved,
--      so an alert can never slow down or block a tap).
--    • The function re-reads the booking itself and only sends if the alert
--      is really due. Each alert is written to alert_log first, so it goes
--      out once however often the function is called.
--    • Phones: everyone in the company who tapped "Turn on notifications",
--      except the person who made the change. Each person can switch the
--      three kinds on or off.
--    • Discord: the owner or manager pastes the channel links in Settings.
--      They are kept where no phone can read them.
-- ════════════════════════════════════════════════════════════════════════
begin;

create extension if not exists pg_net with schema extensions;

-- ── PHONES ─────────────────────────────────────────────────────────────
create table if not exists push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  staff_id    uuid not null references staff(id) on delete cascade,
  company_id  uuid not null references companies(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now()
);
create index if not exists push_subscriptions_staff_idx on push_subscriptions(staff_id);

create table if not exists alert_prefs (
  staff_id    uuid primary key references staff(id) on delete cascade,
  company_id  uuid not null references companies(id) on delete cascade,
  drops       boolean not null default true,     -- CALLED, OVERSTAY, COMPLAINT
  picks       boolean not null default true,     -- RTC
  flights     boolean not null default true,     -- CANCELLED
  updated_at  timestamptz not null default now()
);

create table if not exists alert_log (
  key      text primary key,
  sent_at  timestamptz not null default now()
);

alter table push_subscriptions enable row level security;
alter table alert_prefs enable row level security;
alter table alert_log enable row level security;          -- no policies: the function only
drop policy if exists push_subscriptions_own on push_subscriptions;
create policy push_subscriptions_own on push_subscriptions for select to authenticated using (staff_id = (me()).id);
drop policy if exists alert_prefs_own on alert_prefs;
create policy alert_prefs_own on alert_prefs for select to authenticated using (staff_id = (me()).id);
revoke all on table push_subscriptions, alert_prefs, alert_log from anon, authenticated;
grant select on table push_subscriptions, alert_prefs to authenticated;

-- Save this phone for whoever is signed in. A shared phone follows the
-- person signed in now, not the last one.
create or replace function save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void language plpgsql security definer set search_path = public as $$
declare s staff := me();
begin
  if s.id is null then raise exception 'Sign in again.'; end if;
  if p_endpoint is null or p_endpoint !~ '^https://' or length(p_endpoint) > 1000
     or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then
    raise exception 'This phone did not give a valid notification address.';
  end if;
  insert into push_subscriptions (staff_id, company_id, endpoint, p256dh, auth)
  values (s.id, s.company_id, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set staff_id = excluded.staff_id, company_id = excluded.company_id,
    p256dh = excluded.p256dh, auth = excluded.auth, created_at = now();
end;
$$;

create or replace function remove_push_subscription(p_endpoint text)
returns void language sql security definer set search_path = public as $$
  delete from push_subscriptions where endpoint = p_endpoint and staff_id = (me()).id;
$$;

create or replace function set_alert_prefs(p_drops boolean, p_picks boolean, p_flights boolean)
returns alert_prefs language plpgsql security definer set search_path = public as $$
declare s staff := me(); r alert_prefs;
begin
  if s.id is null then raise exception 'Sign in again.'; end if;
  insert into alert_prefs (staff_id, company_id, drops, picks, flights)
  values (s.id, s.company_id, coalesce(p_drops, true), coalesce(p_picks, true), coalesce(p_flights, true))
  on conflict (staff_id) do update set drops = excluded.drops, picks = excluded.picks, flights = excluded.flights, updated_at = now()
  returning * into r;
  return r;
end;
$$;

-- ── DISCORD ────────────────────────────────────────────────────────────
-- A Discord link works like a password for that channel, so it lives in the
-- private schema. The app only ever learns whether one is set.
create schema if not exists private;
create table if not exists private.discord (
  company_id  uuid primary key references public.companies(id) on delete cascade,
  drops_url   text not null default '',
  picks_url   text not null default '',
  mention     text not null default '@everyone'
);

-- null leaves a link as it is; '' removes it.
create or replace function set_discord(p_drops text, p_picks text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff := me();
begin
  if not can('settings') then raise exception 'Only an owner or manager can change settings.'; end if;
  if coalesce(p_drops, '') <> '' and p_drops !~ '^https://(discord|discordapp)\.com/api/webhooks/\d+/[\w-]+$' then
    raise exception 'The DROPS link must be a Discord webhook link (https://discord.com/api/webhooks/...).';
  end if;
  if coalesce(p_picks, '') <> '' and p_picks !~ '^https://(discord|discordapp)\.com/api/webhooks/\d+/[\w-]+$' then
    raise exception 'The PICKS link must be a Discord webhook link (https://discord.com/api/webhooks/...).';
  end if;
  insert into private.discord (company_id) values (s.company_id) on conflict do nothing;
  update private.discord set drops_url = coalesce(p_drops, drops_url), picks_url = coalesce(p_picks, picks_url)
  where company_id = s.company_id;
  insert into activity(company_id, staff_id, staff_name, action, value)
  values (s.company_id, s.id, s.name, 'SETTINGS', 'Discord links updated');
  return discord_status();
end;
$$;

create or replace function discord_status()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('drops', coalesce(d.drops_url, '') <> '', 'picks', coalesce(d.picks_url, '') <> '')
  from (select my_company() id) c left join private.discord d on d.company_id = c.id
$$;

-- For the send-alerts function only.
create or replace function alert_discord(p_company uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select to_jsonb(d) from private.discord d where d.company_id = p_company
$$;

-- ── WHAT RAISES AN ALERT ───────────────────────────────────────────────
create table if not exists private.alert_config (id boolean primary key default true check (id), function_url text not null);
insert into private.alert_config (function_url)
values ('https://oioqjfrlwrjovnouhusp.supabase.co/functions/v1/send-alerts')
on conflict (id) do nothing;

create or replace function bookings_alert()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare url text; actor uuid;
begin
  if not (
       (new.kind = 'drops' and new.called_at is not null and old.called_at is null)
    or (new.kind = 'drops' and new.clear_word = 'COMPLAINT' and old.clear_word is distinct from 'COMPLAINT')
    or (new.kind = 'picks' and new.intake = 'RTC' and old.intake is distinct from 'RTC')
    or (new.kind = 'drops' and new.flight_status = 'cancelled' and old.flight_status is distinct from 'cancelled')
  ) then return null; end if;
  select function_url into url from private.alert_config;
  if url is null then return null; end if;
  select id into actor from staff where user_id = auth.uid() limit 1;
  perform net.http_post(url := url,
    body := jsonb_build_object('type', 'booking', 'id', new.id, 'actor', actor),
    headers := '{"Content-Type": "application/json"}'::jsonb,
    timeout_milliseconds := 10000);
  return null;
exception when others then
  raise warning 'alert skipped: %', sqlerrm;   -- an alert must never block a tap
  return null;
end;
$$;
drop trigger if exists bookings_alert on bookings;
create trigger bookings_alert after update of called_at, clear_word, intake, flight_status on bookings
  for each row execute function bookings_alert();

-- ── PERMISSIONS ────────────────────────────────────────────────────────
revoke execute on function save_push_subscription(text, text, text), remove_push_subscription(text),
  set_alert_prefs(boolean, boolean, boolean), set_discord(text, text), discord_status() from public, anon;
grant execute on function save_push_subscription(text, text, text), remove_push_subscription(text),
  set_alert_prefs(boolean, boolean, boolean), set_discord(text, text), discord_status() to authenticated;
revoke execute on function alert_discord(uuid), bookings_alert() from public, anon, authenticated;
grant execute on function alert_discord(uuid) to service_role;

commit;
