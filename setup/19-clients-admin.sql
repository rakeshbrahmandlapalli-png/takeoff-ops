-- Parking Ops — database part 19: the product owner's Clients page.
--
-- The product owner signs in to a hidden company, slug "platform", which has
-- no sheets and no cars. Being its owner is the only way into the admin_*
-- functions below. Nothing here gives that login any client's customer data:
-- row level security still keys everything on my_company(), which for the
-- platform login is the platform company. The Clients page sees counts only.
--
-- A suspended client's staff are signed out of everything: me() and
-- my_company() return nothing for them, which every policy and function
-- already treats as "no access". Resuming gives it all back; nothing is lost.
-- Safe to run twice.

alter table companies add column if not exists suspended_at timestamptz;

create or replace function me() returns staff
language sql stable security definer set search_path = public as $$
  select s.* from staff s join companies c on c.id = s.company_id
  where s.user_id = auth.uid() and s.active and c.suspended_at is null limit 1
$$;

create or replace function my_company() returns uuid
language sql stable security definer set search_path = public as $$
  select s.company_id from staff s join companies c on c.id = s.company_id
  where s.user_id = auth.uid() and s.active and c.suspended_at is null limit 1
$$;

create or replace function is_platform_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff s join companies c on c.id = s.company_id
    where s.user_id = auth.uid() and s.active and s.role = 'owner' and c.slug = 'platform')
$$;

insert into companies (name, slug, yards, brand)
values ('Parking Ops', 'platform', '{}', '{"name":"Parking Ops","short":"Parking Ops","colour":"#334155","ink":"#FFFFFF","soft":"#EEF1F5","text":"#1E293B","host":"parking-ops.vercel.app"}')
on conflict (slug) do nothing;

create or replace function admin_clients() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_platform_admin() then raise exception 'Not allowed.'; end if;
  return coalesce((select jsonb_agg(x order by x->>'name') from (
    select jsonb_build_object(
      'id', c.id, 'name', c.name, 'slug', c.slug, 'yards', c.yards, 'brand', c.brand,
      'drops_day_end', c.drops_day_end, 'suspended_at', c.suspended_at, 'created_at', c.created_at,
      'staff', (select count(*) from staff s where s.company_id = c.id and s.active and s.removed_at is null),
      'has_owner', exists (select 1 from staff s where s.company_id = c.id and s.role = 'owner' and s.removed_at is null),
      'sheets_7d', (select count(*) from sheets sh where sh.company_id = c.id and sh.day >= current_date - 7),
      'cars_7d', (select count(*) from bookings b join sheets sh on sh.id = b.sheet_id where b.company_id = c.id and sh.day >= current_date - 7 and b.removed_at is null),
      'last_activity', (select max(a.at) from activity a where a.company_id = c.id)
    ) x from companies c where c.slug <> 'platform') t), '[]'::jsonb);
end;
$$;

-- New client when p has no id; otherwise edits that client. The slug is fixed
-- once made: personal links and the setup link are built from it.
create or replace function admin_save_client(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c companies;
  y text;
  ys text[] := coalesce((select array_agg(upper(trim(v))) from jsonb_array_elements_text(coalesce(p->'yards', '[]')) v where trim(v) <> ''), '{}');
  b jsonb := coalesce(p->'brand', '{}');
  k text;
begin
  if not is_platform_admin() then raise exception 'Not allowed.'; end if;
  if coalesce(trim(p->>'name'), '') = '' then raise exception 'Enter the client''s name.'; end if;
  if array_length(ys, 1) is null then raise exception 'Enter at least one yard.'; end if;
  foreach y in array ys loop
    if y !~ '^[A-Z0-9]{1,4}$' then raise exception 'Yard codes are 1 to 4 letters or numbers: %', y; end if;
  end loop;
  foreach k in array array['colour', 'ink', 'soft', 'text'] loop
    if coalesce(b->>k, '') <> '' and b->>k !~ '^#[0-9A-Fa-f]{6}$' then raise exception 'Colours look like #1560BD (%).', k; end if;
  end loop;
  if coalesce(b->>'host', '') <> '' and b->>'host' !~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$' then raise exception 'The address looks like clientname-ops.vercel.app'; end if;
  b := jsonb_strip_nulls(jsonb_build_object('name', trim(p->>'name'), 'short', nullif(trim(b->>'short'), ''),
    'colour', nullif(b->>'colour', ''), 'ink', nullif(b->>'ink', ''), 'soft', nullif(b->>'soft', ''), 'text', nullif(b->>'text', ''),
    'host', nullif(lower(b->>'host'), ''), 'logo', nullif(b->>'logo', '')));

  if coalesce(p->>'id', '') = '' then
    if coalesce(p->>'slug', '') !~ '^[a-z0-9][a-z0-9-]{1,39}$' then raise exception 'The short code is lower-case letters, numbers and dashes, like airport-parking-bay.'; end if;
    if p->>'slug' = 'platform' then raise exception 'That short code is taken.'; end if;
    if exists (select 1 from companies where slug = p->>'slug') then raise exception 'That short code is taken.'; end if;
    insert into companies (name, slug, yards, drops_day_end, time_zone, brand)
    values (trim(p->>'name'), p->>'slug', ys, coalesce(nullif(p->>'drops_day_end', '')::time, '06:00'), 'Europe/London', b)
    returning * into c;
  else
    update companies set name = trim(p->>'name'), yards = ys,
      drops_day_end = coalesce(nullif(p->>'drops_day_end', '')::time, drops_day_end), brand = brand || b
    where id = (p->>'id')::uuid and slug <> 'platform' returning * into c;
    if not found then raise exception 'Client not found.'; end if;
  end if;
  return to_jsonb(c);
end;
$$;

create or replace function admin_suspend_client(p_id uuid, p_suspend boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c companies;
begin
  if not is_platform_admin() then raise exception 'Not allowed.'; end if;
  update companies set suspended_at = case when p_suspend then coalesce(suspended_at, now()) else null end
  where id = p_id and slug <> 'platform' returning * into c;
  if not found then raise exception 'Client not found.'; end if;
  return to_jsonb(c);
end;
$$;

revoke execute on function is_platform_admin(), admin_clients(), admin_save_client(jsonb), admin_suspend_client(uuid, boolean) from public, anon;
grant execute on function is_platform_admin(), admin_clients(), admin_save_client(jsonb), admin_suspend_client(uuid, boolean) to authenticated;
