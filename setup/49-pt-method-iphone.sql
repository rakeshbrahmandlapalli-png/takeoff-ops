-- Parking Ops — database part 49: a separate PT way for iPhones.
--
-- Settings now has two choices of how PT gets the photos (part 30's photos /
-- pdf / link): pt_method for Android phones (and computers), pt_method_ios
-- for iPhones and iPads. iPhones start with what the company uses now, so
-- nothing changes until someone picks something else. Safe to run twice.

alter table companies add column if not exists pt_method_ios text;
update companies set pt_method_ios = pt_method where pt_method_ios is null;
alter table companies alter column pt_method_ios set default 'photos';
alter table companies alter column pt_method_ios set not null;
alter table companies drop constraint if exists companies_pt_method_ios_check;
alter table companies add constraint companies_pt_method_ios_check check (pt_method_ios in ('photos', 'pdf', 'link'));

create or replace function set_pt_method_ios(p_method text)
returns text language plpgsql security definer set search_path = public as $$
declare
  s staff := me();
begin
  if not can('settings') then raise exception 'Only an owner or manager can change settings.'; end if;
  if p_method not in ('photos', 'pdf', 'link') then raise exception 'Choose photos, PDF or link.'; end if;
  update companies set pt_method_ios = p_method where id = s.company_id;
  insert into activity(company_id, staff_id, staff_name, action, value)
  values (s.company_id, s.id, s.name, 'SETTINGS', case p_method when 'link' then 'iPhones: PT photos sent as a link'
                                                               when 'pdf' then 'iPhones: PT photos sent as one PDF'
                                                               else 'iPhones: PT photos sent in the WhatsApp chat' end);
  return p_method;
end;
$$;
revoke execute on function set_pt_method_ios(text) from public, anon;
grant execute on function set_pt_method_ios(text) to authenticated;
