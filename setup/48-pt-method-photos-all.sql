-- Parking Ops — database part 48: a fourth way to send PT photos.
--
-- Chrome on Android hands WhatsApp at most 10 photos per tap, so with
-- "photos" Android phones now send one PDF (one tap) while iPhones send the
-- photos. 'photos_all' keeps photos on every phone (Android 10 at a time),
-- for a PT that won't take a PDF. Chosen in Settings. Safe to run twice.

alter table companies drop constraint if exists companies_pt_method_check;
alter table companies add constraint companies_pt_method_check check (pt_method in ('photos', 'photos_all', 'pdf', 'link'));

create or replace function set_pt_method(p_method text)
returns text language plpgsql security definer set search_path = public as $$
declare
  s staff := me();
begin
  if not can('settings') then raise exception 'Only an owner or manager can change settings.'; end if;
  if p_method not in ('photos', 'photos_all', 'pdf', 'link') then raise exception 'Choose photos, PDF or link.'; end if;
  update companies set pt_method = p_method where id = s.company_id;
  insert into activity(company_id, staff_id, staff_name, action, value)
  values (s.company_id, s.id, s.name, 'SETTINGS', case p_method when 'link' then 'PT photos sent as a link'
                                                               when 'pdf' then 'PT photos sent as one PDF'
                                                               when 'photos_all' then 'PT photos sent in the WhatsApp chat on every phone (Android 10 at a time)'
                                                               else 'PT photos sent in the WhatsApp chat (Android phones: one PDF)' end);
  return p_method;
end;
$$;
revoke execute on function set_pt_method(text) from public, anon;
grant execute on function set_pt_method(text) to authenticated;
