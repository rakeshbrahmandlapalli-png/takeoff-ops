-- Parking Ops — database part 16: anyone signed in can change their own PIN.
--
-- Needs the current PIN, so a phone left unlocked can't be used to take over
-- someone's sign-in. Wrong current PINs count towards the same 5-try lock as
-- signing in. The personal link stays the same. A forgotten PIN is still reset
-- by the office from Staff (new link + PIN). Safe to run twice.
--
-- Answers with a status instead of raising on a wrong PIN: an error would
-- undo the wrong-try count along with everything else.

create or replace function change_my_pin(p_current text, p_new text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  s staff := me();
  sec staff_secrets;
begin
  if s.id is null then raise exception 'Sign in again.'; end if;
  if p_new is null or p_new !~ '^\d{4}$' then raise exception 'The new PIN must be 4 numbers.'; end if;
  select * into sec from staff_secrets where staff_id = s.id for update;
  if not found then raise exception 'No PIN is set for you. Ask the office to reset your link.'; end if;
  if sec.locked_until is not null and sec.locked_until > now() then
    return jsonb_build_object('status', 'locked', 'until', sec.locked_until);
  end if;
  if p_current is null or crypt(p_current, sec.pin_hash) <> sec.pin_hash then
    update staff_secrets set failed_pins = failed_pins + 1,
      locked_until = case when failed_pins + 1 >= 5 then now() + interval '15 minutes' else null end,
      updated_at = now()
    where staff_id = s.id;
    return jsonb_build_object('status', 'bad_pin', 'left', greatest(0, 4 - sec.failed_pins));
  end if;
  update staff_secrets set pin_hash = crypt(p_new, gen_salt('bf', 10)), failed_pins = 0, locked_until = null, updated_at = now()
  where staff_id = s.id;
  return jsonb_build_object('status', 'ok');
end;
$$;
revoke execute on function change_my_pin(text, text) from public, anon;
grant execute on function change_my_pin(text, text) to authenticated;
