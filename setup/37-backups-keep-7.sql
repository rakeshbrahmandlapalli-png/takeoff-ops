-- Parking Ops — database part 37: nightly backups keep 7 nights, not 14.
--
-- Each backup is a full copy of the company and grows with every booking
-- (~220 a day). 14 of them would reach the free plan's 500 MB database limit
-- in under a year; 7 still gives a week to notice a mistake (a bad import, a
-- wrong delete) and go back to a night before it. Same function as part 21
-- otherwise. Safe to run twice.

create or replace function take_backups()
returns integer language plpgsql security definer set search_path = public as $$
declare c companies; d jsonb; n integer := 0;
begin
  for c in select * from companies where slug <> 'platform' loop
    d := export_company(c.slug);
    insert into private.backups(company_id, bookings, bytes, data)
    values (c.id, jsonb_array_length(d->'bookings'), octet_length(d::text), d);
    n := n + 1;
    -- keep the newest 7 per company
    delete from private.backups b where b.company_id = c.id and b.id not in
      (select id from private.backups where company_id = c.id order by taken_at desc limit 7);
  end loop;
  return n;
end $$;
revoke execute on function take_backups() from public, anon, authenticated;
