-- Parking Ops — database part 34: indexes on the history table.
--
-- Imports check each car's history (was the flight typed in by the office?),
-- deleting a sheet counts its history, and the car panel reads it. Without
-- these every lookup read the whole activity table, which grows every night.
-- Safe to run twice.

create index if not exists activity_booking_idx on activity(booking_id) where booking_id is not null;
create index if not exists activity_sheet_idx on activity(sheet_id) where sheet_id is not null;

-- The event trigger that switches row security on for new tables runs by
-- itself; nobody needs to be able to call it (it can't be called anyway).
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
