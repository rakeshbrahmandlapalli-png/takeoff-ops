-- Parking Ops — database part 76: the exit fee, the bookings that don't pay it,
-- and the payment taken by cash or card with a photo.
--
-- Settings → Exit fee (owners only): the fee (e.g. £10 at Airport Parking
-- Bay; 0 = off) and the reference starts that don't pay it (agent codes like
-- CAP, or whole references). Kept upper case, letters and numbers only; the
-- app compares references the same way, so "Cpd 19660209" starts with CPD.
-- On a DROPS car, anyone who can CLEAR marks the fee paid by CASH or CARD,
-- with a photo of the payment kept with the car (pt-photos bucket,
-- <company>/docs/<booking>/x<time>.jpg, 90 days like the docket photos).
--   • companies.exit_fee / exit_free, set_exit_fee()
--   • bookings.exit_method / exit_amount / exit_at / exit_by / exit_photo,
--     set_exit_paid()
-- Nothing changes for a company until its owner sets a fee. Safe to run twice.
-- Needs part 69 (photo folder and read policy).

alter table companies add column if not exists exit_fee  numeric(8,2) not null default 0;
alter table companies add column if not exists exit_free text[]       not null default '{}';

alter table bookings add column if not exists exit_method text not null default '';
alter table bookings add column if not exists exit_amount numeric(8,2);
alter table bookings add column if not exists exit_at     timestamptz;
alter table bookings add column if not exists exit_by     uuid references staff(id) on delete set null;
alter table bookings add column if not exists exit_photo  text not null default '';

-- Owners only (not managers): the fee and who doesn't pay it.
create or replace function set_exit_fee(p_fee numeric, p_free text[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s staff := me();
  free text[] := coalesce((select array_agg(distinct v order by v) from (
    select upper(regexp_replace(e, '[^A-Za-z0-9]', '', 'g')) v from unnest(coalesce(p_free, '{}')) e) x where v <> ''), '{}');
begin
  if s.role <> 'owner' then raise exception 'Only an owner can change the exit fee.'; end if;
  if p_fee is null or p_fee < 0 or p_fee > 999 then raise exception 'The exit fee is £0 to £999.'; end if;
  if coalesce(array_length(free, 1), 0) > 200 then raise exception 'Up to 200 references without the exit fee.'; end if;
  if exists (select 1 from unnest(free) v where length(v) > 40) then raise exception 'A reference is 40 letters or numbers at most.'; end if;
  update companies set exit_fee = round(p_fee, 2), exit_free = free where id = s.company_id;
  insert into activity(company_id, staff_id, staff_name, action, value)
  values (s.company_id, s.id, s.name, 'SETTINGS', case when p_fee = 0 then 'Exit fee switched off'
    else 'Exit fee £' || round(p_fee, 2) || coalesce(', not for ' || nullif(array_to_string(free, ', '), ''), '') end);
  return jsonb_build_object('exit_fee', round(p_fee, 2), 'exit_free', to_jsonb(free));
end;
$$;
revoke execute on function set_exit_fee(numeric, text[]) from public, anon;
grant execute on function set_exit_fee(numeric, text[]) to authenticated;

-- Anyone who can CLEAR (like overstay charges) marks it paid; '' undoes it.
create or replace function set_exit_paid(p_booking uuid, p_method text, p_photo text)
returns bookings language plpgsql security definer set search_path = public as $$
declare
  b bookings := booking_for_update(p_booking);
  s staff := me();
  c companies;
  photo text := coalesce(p_photo, '');
begin
  if not can('clear') then raise exception 'Not allowed for your role: %', s.role; end if;
  if b.kind <> 'drops' then raise exception 'The exit fee is taken on DROPS cars.'; end if;
  if coalesce(p_method, '') = '' then
    update bookings set exit_method = '', exit_amount = null, exit_at = null, exit_by = null, exit_photo = '', updated_at = now()
    where id = b.id returning * into b;
    perform log_activity(b, 'EXIT FEE', '(cleared)');
    return b;
  end if;
  if p_method not in ('cash', 'card') then raise exception 'Not a valid way to pay: %', p_method; end if;
  select * into c from companies where id = b.company_id;
  if c.exit_fee <= 0 then raise exception 'There is no exit fee set.'; end if;
  if photo <> '' and photo !~ ('^' || b.company_id::text || '/docs/' || b.id::text || '/x[0-9]+\.jpg$') then raise exception 'That photo is not this car''s.'; end if;
  update bookings set exit_method = p_method, exit_amount = c.exit_fee, exit_at = now(), exit_by = s.id, exit_photo = photo, updated_at = now()
  where id = b.id returning * into b;
  perform log_activity(b, 'EXIT FEE', '£' || c.exit_fee || ' ' || p_method || case when photo <> '' then ' (photo)' else '' end);
  return b;
end;
$$;
revoke execute on function set_exit_paid(uuid, text, text) from public, anon;
grant execute on function set_exit_paid(uuid, text, text) to authenticated;
