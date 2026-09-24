--  TAKEOFF OPS — part 12: add Airport Parking Bay as the second company
--
--  Run parts 9 and 11 FIRST and read their results. If either shows a FAIL,
--  stop: this is the point where a second company's real customers arrive.
--
--  Airport Parking Bay, Luton. Also trades as 24/7 and as 247; the same firm.
--  Nothing about TakeOff changes — this only adds rows.

insert into companies (name, slug, yards, drops_day_end, time_zone, brand)
values (
  'Airport Parking Bay',
  'airport-parking-bay',
  -- Their yards. Change them here and the app's pickers, counters and chips
  -- all follow; nothing is hard-coded to one company's letters.
  '{GS,MY,T}',
  '06:00',
  'Europe/London',
  jsonb_build_object(
    'name',   'Airport Parking Bay',
    'short',  'Parking Bay',          -- what fits in the top bar
    'colour', '#1560BD',              -- the blue from their sign
    'ink',    '#FFFFFF',              -- text on that blue
    'soft',   '#E8F0FB',
    'text',   '#0E3F7E',
    -- their own address, so the app knows whose it is before anyone signs in
    'host',   'parkingbay-ops.vercel.app',
    'logo',   '/icons/apb-192.png'
  )
)
on conflict (slug) do update
  set name = excluded.name, yards = excluded.yards, brand = excluded.brand;

-- ── their first sign-in ───────────────────────────────────────────────────
-- Do NOT add their owner here. The app does it, so the link and PIN are
-- generated and shown once rather than sitting in a SQL file: open
--
--     https://parkingbay-ops.vercel.app/#setup=airport-parking-bay
--
-- enter a name and the SETUP_CODE, and it prints their personal link and PIN.
-- That screen only works while the company has nobody in it, so adding a staff
-- row here by hand would lock it out. Everyone else they add from inside the
-- app afterwards.
--
-- Send the link and the PIN separately (link by email, PIN by text), and tell
-- them to open the link on the phone and then Add to Home Screen — on an
-- iPhone, notifications only work from the Home Screen copy.

-- ── check ─────────────────────────────────────────────────────────────────
select c.name, c.slug, c.yards, c.brand->>'colour' as colour,
       (select count(*) from staff s where s.company_id = c.id) as staff,
       (select count(*) from bookings b where b.company_id = c.id) as bookings
from companies c order by c.name;
