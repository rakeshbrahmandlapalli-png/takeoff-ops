-- Parking Ops — database part 60: use the Pro plan's room (3 Oct 2026).
--
-- 1. Airport Parking Bay's PT copies go to Cloudflare R2, like TakeOff's
--    (part 43): every photo, "good" quality (1280 px), kept 30 days. On
--    Supabase's store they were 10 small photos a car (800 px), cut down to
--    fit the free plan's 1 GB. No app change: the phones read pt_copy_store.
--    Sets already taken stay where they are and are still shown.
-- 2. Indexes Supabase's advisor suggests where they help reads: a car's PT
--    photos, a company's links, a staff member's history, alert settings.
--    The bookings.*_by columns are left unindexed on purpose: every tap
--    writes one, and an index there would make each tap heavier.
-- 3. Two functions get a fixed search_path (advisor: mutable search_path).
-- Safe to run twice.

update companies set pt_copy_store = 'r2' where slug = 'airport-parking-bay';

create index if not exists pt_links_booking_idx on pt_links(booking_id);
create index if not exists pt_links_company_idx on pt_links(company_id);
create index if not exists activity_staff_idx on activity(staff_id);
create index if not exists alert_prefs_company_idx on alert_prefs(company_id);
create index if not exists push_subscriptions_company_idx on push_subscriptions(company_id);

alter function drops_day_of(timestamptz, companies) set search_path = public;
alter function bookings_skip_noop() set search_path = public;

-- Check
select name, pt_copy_store from companies order by name;
