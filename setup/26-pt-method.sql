-- Parking Ops — database part 26: how PT gets the photos.
--
--   photos  the photos go into the PT WhatsApp chat (reg first, then the
--           photos in albums of 10). The default.
--   link    the photos upload and PT gets one message with a link to them
--           (part 25). Switch to this once PT has agreed to it.
-- Owner and manager choose in Settings, for the whole company.
-- Safe to run twice.

alter table companies add column if not exists pt_method text not null default 'photos';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'companies_pt_method_check') then
    alter table companies add constraint companies_pt_method_check check (pt_method in ('photos', 'link'));
  end if;
end $$;

create or replace function set_pt_method(p_method text)
returns text language plpgsql security definer set search_path = public as $$
declare
  s staff := me();
begin
  if not can('settings') then raise exception 'Only an owner or manager can change settings.'; end if;
  if p_method not in ('photos', 'link') then raise exception 'Choose photos or link.'; end if;
  update companies set pt_method = p_method where id = s.company_id;
  insert into activity(company_id, staff_id, staff_name, action, value)
  values (s.company_id, s.id, s.name, 'SETTINGS', case when p_method = 'link' then 'PT photos sent as a link' else 'PT photos sent in the WhatsApp chat' end);
  return p_method;
end;
$$;
revoke execute on function set_pt_method(text) from public, anon;
grant execute on function set_pt_method(text) to authenticated;
