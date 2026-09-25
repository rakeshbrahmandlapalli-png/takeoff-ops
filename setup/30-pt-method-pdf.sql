-- Parking Ops — database part 30: PT photos as one PDF, chosen in Settings.
--
-- A third choice next to part 26's two:
--   photos  reg, then the photos in the WhatsApp chat (10 at a time on Android)
--   pdf     every photo in one PDF, one share (the app makes the PDF)
--   link    one message with a link to the photos (once PT has agreed)
-- Safe to run twice.

alter table companies drop constraint if exists companies_pt_method_check;
alter table companies add constraint companies_pt_method_check check (pt_method in ('photos', 'pdf', 'link'));

create or replace function set_pt_method(p_method text)
returns text language plpgsql security definer set search_path = public as $$
declare
  s staff := me();
begin
  if not can('settings') then raise exception 'Only an owner or manager can change settings.'; end if;
  if p_method not in ('photos', 'pdf', 'link') then raise exception 'Choose photos, PDF or link.'; end if;
  update companies set pt_method = p_method where id = s.company_id;
  insert into activity(company_id, staff_id, staff_name, action, value)
  values (s.company_id, s.id, s.name, 'SETTINGS', case p_method when 'link' then 'PT photos sent as a link'
                                                               when 'pdf' then 'PT photos sent as one PDF'
                                                               else 'PT photos sent in the WhatsApp chat' end);
  return p_method;
end;
$$;
revoke execute on function set_pt_method(text) from public, anon;
grant execute on function set_pt_method(text) to authenticated;
