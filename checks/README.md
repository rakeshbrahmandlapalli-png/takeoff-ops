# Checks

Run these before merging a change. Every line must say ok / PASS.

| What | How | Covers |
|---|---|---|
| `db-tests.sql` | Paste into the Supabase SQL editor (or run through the Supabase connector). It always ends with `ERROR: DB TESTS: N passed, 0 failed` — that error is how it rolls everything back. | Roles, one company never touching another's cars or photos, taps, early returns, re-imports, the 06:00 carry-over, changed return dates, PT links and the photo store. |
| `e2e/run.mjs` | `cd checks/e2e && npm install playwright@1 && node run.mjs` (set `CHROMIUM=` to a Chrome/Chromium if Playwright's own isn't installed). | The real app in a phone-sized browser against a pretend Supabase: board, taps and names, search incl. other days, car panel, early return, PICKS tiles, PT in all three ways, PT's link page, Settings, Supabase down, error safety net, hostile data (XSS), typed times, SAME/NEXT and WAS tags, 360 px phones — all served with the real security headers from vercel.json. |
| `dates.cjs` | `node checks/dates.cjs` | Shift day, return day and overstay charges across the clocks going back (25 Oct) and forward (29 Mar), and a changed return charged from its first date. |
| `joblist.cjs` | See the top of the file; needs the sample PDFs, which hold real customer data and aren't in the repo. | Reading the booking PDFs. |

`setup/09-isolation-check.sql` and `setup/11-function-isolation-check.sql` are the older isolation checks (they leave a small results table behind).

To prove the browser tests can fail, point them at a deliberately broken copy: `APP_ROOT=/path/to/copy/of/public node run.mjs`.
