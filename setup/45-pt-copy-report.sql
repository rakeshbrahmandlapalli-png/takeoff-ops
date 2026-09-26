-- Parking Ops — database part 45: phones report when a PT photo copy fails.
--
-- 26 Sept: one phone PT'd about 55 cars and none of their copies reached the
-- app, with nothing to say why. Now the phone reports it: a PT COPY line in
-- the activity log with the reason (upload refused, no signal, never
-- started and what it was waiting for, ticked without photos...). Only for
-- a car on the caller's own board, once per car and message an hour, 300
-- characters at most. Seen in Summary → activity, and by support.
-- Safe to run twice.

create or replace function pt_copy_report(p_booking uuid, p_detail text)
returns void language plpgsql security definer set search_path = public as $$
declare
  s staff := me();
  b bookings;
  v text := left(regexp_replace(coalesce(p_detail, ''), '[[:cntrl:]]+', ' ', 'g'), 300);
begin
  if s.id is null or v = '' then return; end if;
  select * into b from bookings where id = p_booking and company_id = s.company_id;
  if b.id is null then return; end if;
  if exists (select 1 from activity where booking_id = b.id and action = 'PT COPY' and value = v and at > now() - interval '1 hour') then return; end if;
  insert into activity(company_id, staff_id, staff_name, sheet_id, booking_id, reg, customer, action, value)
  values (s.company_id, s.id, s.name, b.sheet_id, b.id, b.reg, b.name, 'PT COPY', v);
end;
$$;
revoke execute on function pt_copy_report(uuid, text) from public, anon;
grant execute on function pt_copy_report(uuid, text) to authenticated;
