-- ════════════════════════════════════════════════════════════════════════
--  TAKEOFF OPS — part 2: personal link + PIN sign-in
--
--  Run after part 1. Safe to run again.
--
--  These functions are for the two Edge Functions only (staff-login and
--  manage-staff), which run with the service key inside Supabase. No phone and
--  no signed-in user can call them.
--
--  A personal link carries a long random token; only its sha256 is stored.
--  The PIN is stored as a bcrypt hash. Five wrong PINs lock that person for
--  15 minutes, so a PIN can't be guessed.
-- ════════════════════════════════════════════════════════════════════════
begin;

create extension if not exists pgcrypto with schema extensions;

-- Checks a link + PIN. Returns the login behind it, or why not.
create or replace function staff_login_check(p_link_hash text, p_pin text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  sec staff_secrets;
  st staff;
begin
  select * into sec from staff_secrets where link_hash = p_link_hash for update;
  if not found then return jsonb_build_object('status', 'bad_link'); end if;
  select * into st from staff where id = sec.staff_id;
  if not found or not st.active or st.user_id is null then return jsonb_build_object('status', 'inactive'); end if;
  if sec.locked_until is not null and sec.locked_until > now() then
    return jsonb_build_object('status', 'locked', 'until', sec.locked_until);
  end if;
  if p_pin is null or p_pin !~ '^\d{4}$' or crypt(p_pin, sec.pin_hash) <> sec.pin_hash then
    update staff_secrets set failed_pins = failed_pins + 1,
      locked_until = case when failed_pins + 1 >= 5 then now() + interval '15 minutes' else null end,
      updated_at = now()
    where staff_id = sec.staff_id;
    return jsonb_build_object('status', 'bad_pin', 'left', greatest(0, 4 - sec.failed_pins));
  end if;
  update staff_secrets set failed_pins = 0, locked_until = null, updated_at = now() where staff_id = sec.staff_id;
  return jsonb_build_object('status', 'ok', 'user_id', st.user_id, 'name', st.name);
end;
$$;

-- Stores a new link + PIN for a person (new starter, or a reset).
create or replace function set_staff_secret(p_staff uuid, p_link_hash text, p_pin text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_pin !~ '^\d{4}$' then raise exception 'The PIN must be 4 digits.'; end if;
  insert into staff_secrets(staff_id, link_hash, pin_hash)
  values (p_staff, p_link_hash, crypt(p_pin, gen_salt('bf', 10)))
  on conflict (staff_id) do update set link_hash = excluded.link_hash, pin_hash = excluded.pin_hash,
    failed_pins = 0, locked_until = null, updated_at = now();
end;
$$;

-- Who is calling manage-staff, checked with their own sign-in.
create or replace function staff_admin_context()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('staff_id', s.id, 'company_id', s.company_id, 'role', s.role, 'name', s.name, 'can_staff', can('staff'))
  from staff s where s.user_id = auth.uid() and s.active limit 1
$$;

revoke execute on function staff_login_check(text, text), set_staff_secret(uuid, text, text) from public, anon, authenticated;
grant execute on function staff_login_check(text, text), set_staff_secret(uuid, text, text) to service_role;
revoke execute on function staff_admin_context() from public, anon;
grant execute on function staff_admin_context() to authenticated, service_role;

commit;
