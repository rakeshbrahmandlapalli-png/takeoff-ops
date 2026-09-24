-- Parking Ops — database part 20: the WhatsApp number PT photos go to.
--
-- PT opens WhatsApp straight into this chat with the reg ready as the caption.
-- (A web app can't hand more than 10 photos to WhatsApp on Android, and the
-- team sends 40 to 55, so the photos are attached inside WhatsApp itself.)
-- Each company has its own number; owner and manager set it in Settings.
-- Stored as digits with the country code, no plus: 447932029349.
-- Safe to run twice.

alter table companies add column if not exists pt_whatsapp text not null default '';

create or replace function set_pt_whatsapp(p_number text)
returns text language plpgsql security definer set search_path = public as $$
declare
  s staff := me();
  n text := regexp_replace(coalesce(p_number, ''), '[^0-9]', '', 'g');
begin
  if not can('settings') then raise exception 'Only an owner or manager can change settings.'; end if;
  if n like '0%' then n := '44' || substr(n, 2); end if;          -- UK number typed as 07...
  if n <> '' and n !~ '^[1-9][0-9]{9,14}$' then raise exception 'That doesn''t look like a phone number.'; end if;
  update companies set pt_whatsapp = n where id = s.company_id;
  insert into activity(company_id, staff_id, staff_name, action, value)
  values (s.company_id, s.id, s.name, 'SETTINGS', case when n = '' then 'PT WhatsApp number removed' else 'PT WhatsApp number set' end);
  return n;
end;
$$;
revoke execute on function set_pt_whatsapp(text) from public, anon;
grant execute on function set_pt_whatsapp(text) to authenticated;
