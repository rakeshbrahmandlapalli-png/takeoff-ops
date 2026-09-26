-- Parking Ops — database part 42: PT photo copies kept 15 days (was 3).
--
-- Apply together with the app version that keeps 10 small copies per car
-- (~35 KB each, ~0.35 MB a car): ~135 cars a night x 15 days ≈ 0.7 GB, under
-- the 850 MB cap (part 35), which still removes the oldest sets first on a
-- very busy fortnight. Existing links keep the expiry they were made with.
-- Safe to run twice.

alter table pt_links alter column expires_at set default now() + interval '15 days';
