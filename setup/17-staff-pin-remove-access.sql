-- Parking Ops — database part 17: managers and the owner can set someone's
-- PIN, remove a person, and choose exactly what each person can do.
--
-- Rules for all three:
--   * the caller must be a manager or the owner (office cannot)
--   * only people in the caller's own company
--   * never yourself (use Me for your own PIN; you can't lock yourself out)
--   * only an owner can change another owner
--
-- Removing keeps the person's name on everything they did: the staff row stays
-- (marked removed, hidden from the list) but their sign-in, link, PIN and
-- notifications are deleted, so they can never get back in.
--
-- Access is stored in staff.extra, which can() already reads (part 1):
-- "flights" gives a permission the role doesn't have, "-flights" takes away
-- one it does. Safe to run twice.

alter table staff add column if not exists removed_at timestamptz;

create or replace function staff_target(p_staff uuid) returns staff
language plpgsql security definer set search_path = public as $$
declare
  s staff := me();
  t staff;
begin
  if s.id is null or s.role not in ('manager', 'owner') then raise exception 'Only a manager or the owner can do that.'; end if;
  select * into t from staff where id = p_staff and company_id = s.company_id and removed_at is null for update;
  if not found then raise exception 'Person not found.'; end if;
  if t.id = s.id then raise exception 'You can''t do that to yourself.'; end if;
  if t.role = 'owner' and s.role <> 'owner' then raise exception 'Only an owner can change an owner.'; end if;
  return t;
end;
$$;
revoke execute on function staff_target(uuid) from public, anon, authenticated;

create or replace function set_staff_pin(p_staff uuid, p_pin text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  t staff := staff_target(p_staff);
begin
  if p_pin is null or p_pin !~ '^\d{4}$' then raise exception 'The PIN must be 4 numbers.'; end if;
  update staff_secrets set pin_hash = crypt(p_pin, gen_salt('bf', 10)), failed_pins = 0, locked_until = null, updated_at = now()
  where staff_id = t.id;
  if not found then raise exception '% has no link yet. Use New link instead.', t.name; end if;
  insert into activity(company_id, staff_id, staff_name, action, value)
  select t.company_id, s.id, s.name, 'STAFF', 'Changed PIN for ' || t.name from me() s;
end;
$$;

create or replace function remove_staff(p_staff uuid)
returns void language plpgsql security definer set search_path = public, auth as $$
declare
  t staff := staff_target(p_staff);
begin
  delete from staff_secrets where staff_id = t.id;
  delete from push_subscriptions where staff_id = t.id;
  update staff set active = false, removed_at = now(), user_id = null where id = t.id;
  if t.user_id is not null then delete from auth.users where id = t.user_id; end if;
  insert into activity(company_id, staff_id, staff_name, action, value)
  select t.company_id, s.id, s.name, 'STAFF', 'Removed ' || t.name from me() s;
end;
$$;

create or replace function set_staff_access(p_staff uuid, p_extra text[])
returns staff language plpgsql security definer set search_path = public as $$
declare
  t staff := staff_target(p_staff);
  x text;
  allowed text[] := array['sent','called','clear','yard','note','flights','intake','rtc','picksinfo','summary','log','import','staff','settings'];
begin
  foreach x in array coalesce(p_extra, '{}') loop
    if not (ltrim(x, '-') = any(allowed)) then raise exception 'Unknown permission: %', x; end if;
  end loop;
  update staff set extra = coalesce(p_extra, '{}') where id = t.id returning * into t;
  insert into activity(company_id, staff_id, staff_name, action, value)
  select t.company_id, s.id, s.name, 'STAFF', 'Changed access for ' || t.name from me() s;
  return t;
end;
$$;

revoke execute on function set_staff_pin(uuid, text), remove_staff(uuid), set_staff_access(uuid, text[]) from public, anon;
grant execute on function set_staff_pin(uuid, text), remove_staff(uuid), set_staff_access(uuid, text[]) to authenticated;
