--  Parking Ops — part 14: TakeOff's colours become TakeOff's, not the product's
--
--  The app was built for one company and wore their amber everywhere, so their
--  first competitor signed in and met a rival's colour. The product is now
--  neutral slate, and every company's look comes from its own row — including
--  TakeOff's, which is what this puts back.
--
--  Run this after part 13. Nothing about how TakeOff looks changes: the amber
--  simply now belongs to them instead of to the product.

update companies
set brand = coalesce(brand, '{}'::jsonb) || jsonb_build_object(
  'name',   'TakeOff',
  'short',  'TakeOff',
  'colour', '#F9A01B',           -- their amber, as it always was
  'ink',    '#16181D',
  'soft',   '#FFF3DF',
  'text',   '#8A5300',
  'host',   'takeoff-ops.vercel.app'
)
where slug = 'takeoff';

-- Check: each company owns its own colour and address, and neither is the
-- product's.
select name, slug, brand->>'colour' as colour, brand->>'host' as host
from companies order by name;
