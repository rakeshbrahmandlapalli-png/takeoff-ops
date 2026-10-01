-- Parking Ops — database part 57: Airport Parking Bay wears the "pro" look.
--
-- The look lives in public/pro.css and is switched on per company by its brand:
--   theme  'pro'   the navy bar, number-plate regs, Barlow type
--   chrome         the bar's colour (defaults to the brand's text colour)
--   mark           the letter in the square (defaults to the first letter of the short name)
-- Nothing else changes: same board, same buttons, same data. TakeOff keeps its
-- look; to give it this one later, run the same update for slug 'takeoff'.
-- To switch it off again: brand - 'theme'. Safe to run twice.

update companies
set brand = coalesce(brand, '{}'::jsonb) || jsonb_build_object('theme', 'pro', 'chrome', '#0E3F7E', 'mark', 'P')
where slug = 'airport-parking-bay';

-- Check: Airport Parking Bay shows theme pro; the sign-in screen gets it too.
select name, brand->>'theme' as theme, brand->>'chrome' as chrome, brand->>'mark' as mark
from companies order by name;
select public_brand('parkingbay-ops.vercel.app')->'brand'->>'theme' as sign_in_screen_theme;
