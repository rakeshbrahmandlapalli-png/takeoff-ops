# Checks

Run these before merging a change. Every line must say ok / PASS.

| What | How | Covers |
|---|---|---|
| `db-tests.sql` | Paste into the Supabase SQL editor (or run through the Supabase connector). It always ends with `ERROR: DB TESTS: N passed, 0 failed` — that error is how it rolls everything back. | Roles, one company never touching another's cars or photos, taps, early returns, re-imports, the 06:00 carry-over, changed return dates, PT links and the photo store. |
| `e2e/run.mjs` | `cd checks/e2e && npm install playwright@1 && node run.mjs` (set `CHROMIUM=` to a Chrome/Chromium if Playwright's own isn't installed). | The real app in a phone-sized browser against a pretend Supabase: board, taps and names, search incl. other days, car panel, early return, PICKS tiles, PT in all three ways, PT's link page, Settings, Supabase down, error safety net, hostile data (XSS), typed times, SAME/NEXT and WAS tags, 360 px phones — all served with the real security headers from vercel.json. |
| `e2e/run.mjs` with `STRESS=1` | `cd checks/e2e && STRESS=1 node run.mjs` (about 3 min; only the stress tests). Add `PROFILE=1` to print where a tap's time goes. | 800 DROPS + 800 PICKS on a phone 4× slower (open, tap, scroll, search, switch sheet); no signal (taps kept, sent once each in order, undo kept in order), app closed and opened again with no signal, weak signal (2.5 s per save), signal dropping (first try cut off); 500-car Excel imports for DROPS and PICKS, twice. |
| `stress-joblist.cjs` | `node checks/stress-joblist.cjs` (no installs) | A made-up 6-page, 300-booking Joblist through the PDF reader: none merged or lost, VIP references and wrapped names joined back. |
| `dates.cjs` | `node checks/dates.cjs` | Shift day, return day and overstay charges across the clocks going back (25 Oct) and forward (29 Mar), and a changed return charged from its first date. |
| `desk-booking.mjs` | `npm install @electric-sql/pglite` then `node desk-booking.mjs` (no database needed). | Setup part 69: desk bookings on PICKS and docket photos (kept 90 days). |
| `carry-from-picks.mjs` | `npm install @electric-sql/pglite` then `node carry-from-picks.mjs` (no database needed). | Setup part 68: the PICKS yard, note and £ carried to the DROPS car. |
| `drops-yard-to-picks.mjs` | `npm install @electric-sql/pglite` then `node drops-yard-to-picks.mjs` (no database needed). | Setup part 73: the dashboard counts a car under its DROPS yard when PICKS has none; a DROPS yard fills in an empty PICKS location. |
| `yard-both-ways.mjs` | `npm install @electric-sql/pglite` then `node yard-both-ways.mjs` (no database needed). | Setup part 79: a yard set on DROPS or PICKS is copied to the other car (latest change wins; T and clearing are not copied). |
| `dashboard-drops-days.mjs` | `npm install @electric-sql/pglite` then `node dashboard-drops-days.mjs` (no database needed). | Setup part 80: dashboard return days run 06:00 to 06:00 (DROPS days); the list of cars past their return. |
| `booked-days.mjs` | `npm install @electric-sql/pglite` then `node booked-days.mjs` (no database needed). | Setup part 81: pasted cars-on-site totals (`set_booked_days`); the dashboard no longer uses them (part 82). |
| `onsite-by-day.mjs` | `npm install @electric-sql/pglite` then `node onsite-by-day.mjs` (no database needed). | Setup part 82: cars on site per day (here / in / out) counted from the app's own cars. |
| `yard-colours.mjs` | `npm install @electric-sql/pglite` then `node yard-colours.mjs` (no database needed). | Setup part 77: yard colours, owners only; Airport Parking Bay starts with MY green, GS orange, T yellow. |
| `flight-sources.mjs` | `node checks/flight-sources.mjs` (no installs, Node 22) | The flights edge function with pretend APIs: Check flights calls FlightRadar24 only; AeroData from the timer every 90 min (tonight's sheet, only chunks with a car still waiting) and from Fill times (once per sheet per 10 min); none on a sheet whose flights have all landed, or for 6 h after its monthly quota runs out. |
| `joblist.cjs` | See the top of the file; needs the sample PDFs, which hold real customer data and aren't in the repo. | Reading the booking PDFs. |

`setup/09-isolation-check.sql` and `setup/11-function-isolation-check.sql` are the older isolation checks. They leave a small results table behind; drop it afterwards (`setup/39-drop-old-check-results.sql`).

To prove the browser tests can fail, point them at a deliberately broken copy: `APP_ROOT=/path/to/copy/of/public node run.mjs`.
