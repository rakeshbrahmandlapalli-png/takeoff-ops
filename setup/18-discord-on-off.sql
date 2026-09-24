-- Parking Ops — database part 18: switch Discord alerts off and on without
-- losing the links. One switch for the whole company (it is one channel);
-- owner and manager only, like the rest of Settings. Safe to run twice.

alter table private.discord add column if not exists paused boolean not null default false;

create or replace function discord_status()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('drops', coalesce(d.drops_url, '') <> '', 'picks', coalesce(d.picks_url, '') <> '',
    'paused', coalesce(d.paused, false))
  from (select my_company() id) c left join private.discord d on d.company_id = c.id
$$;

create or replace function set_discord_paused(p_paused boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s staff := me();
begin
  if not can('settings') then raise exception 'Only an owner or manager can change settings.'; end if;
  insert into private.discord (company_id) values (s.company_id) on conflict do nothing;
  update private.discord set paused = coalesce(p_paused, false) where company_id = s.company_id;
  insert into activity(company_id, staff_id, staff_name, action, value)
  values (s.company_id, s.id, s.name, 'SETTINGS', case when p_paused then 'Discord alerts switched off' else 'Discord alerts switched on' end);
  return discord_status();
end;
$$;
revoke execute on function set_discord_paused(boolean) from public, anon;
grant execute on function set_discord_paused(boolean) to authenticated;

-- While paused the alert sender sees no links, so nothing is posted.
create or replace function alert_discord(p_company uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when d.paused then to_jsonb(d) || '{"drops_url": "", "picks_url": ""}'::jsonb else to_jsonb(d) end
  from private.discord d where d.company_id = p_company
$$;
