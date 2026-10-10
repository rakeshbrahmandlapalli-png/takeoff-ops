-- Parking Ops — database part 79: a yard set on either car of a booking is copied to the other.
--
-- Part 73 copied a DROPS yard to its PICKS car only when PICKS had no location.
-- Now the latest change wins both ways (only for clients with Location on PICKS):
--   • DROPS → PICKS: overwrites the PICKS location ("from DROPS" in its history).
--   • PICKS → DROPS: the open DROPS car (same ref, or same reg when there's no
--     ref; not removed, not cleared) takes it ("from PICKS" in its history).
-- T (terminal) is never copied either way, and clearing a yard isn't copied.
-- As part 73 otherwise. Safe to run twice. Needs part 73.

create or replace function set_yard(p_booking uuid, p_yard text)
returns bookings language plpgsql security definer set search_path = public as $$
declare
  b bookings := booking_for_update(p_booking);
  y text := upper(trim(coalesce(p_yard, '')));
  yards text[];
  p bookings;
begin
  if not (can('yard') or (b.kind = 'picks' and can('intake'))) then raise exception 'Not allowed for your role: yard'; end if;
  select c.yards into yards from companies c where c.id = b.company_id;
  if y <> '' and not (y = any(yards)) then raise exception 'Not a valid yard: %', y; end if;
  -- The office's choice always wins, including T for cars left at the
  -- terminal. Forget the pre-SENT yard so undoing SENT can't overwrite it.
  update bookings set yard = y, yard_before_t = '', updated_at = now() where id = b.id returning * into b;
  perform log_activity(b, 'YARD', coalesce(nullif(y, ''), '(cleared)'));
  if y <> '' and y <> 'T'
     and exists (select 1 from companies c where c.id = b.company_id and c.brand->>'picks_yard' = 'true') then
    if b.kind = 'drops' then
      -- Part 73 car matching, now overwriting the PICKS location.
      select * into p from bookings x
      where x.company_id = b.company_id and x.kind = 'picks' and x.removed_at is null
        and (case when b.ref <> '' then x.ref = b.ref else x.reg = b.reg and b.reg <> '' end)
        and (b.return_at is null or x.drop_at is null or (x.drop_at <= b.return_at + interval '1 day' and x.drop_at > b.return_at - interval '120 days'))
      order by x.drop_at desc nulls last limit 1;
      if found and p.yard <> y then
        update bookings set yard = y, updated_at = now() where id = p.id returning * into p;
        perform log_activity(p, 'YARD', y || ' · from DROPS');
      end if;
    elsif b.kind = 'picks' then
      -- The car's open DROPS car (latest return); one at the terminal (T) is left alone.
      select * into p from bookings x
      where x.company_id = b.company_id and x.kind = 'drops' and x.removed_at is null and x.cleared_at is null
        and (case when b.ref <> '' then x.ref = b.ref else x.reg = b.reg and b.reg <> '' end)
      order by x.return_at desc nulls last limit 1;
      if found and p.yard <> y and p.yard <> 'T' then
        update bookings set yard = y, updated_at = now() where id = p.id returning * into p;
        perform log_activity(p, 'YARD', y || ' · from PICKS');
      end if;
    end if;
  end if;
  return b;
end;
$$;
revoke execute on function set_yard(uuid, text) from public, anon;
grant execute on function set_yard(uuid, text) to authenticated;
