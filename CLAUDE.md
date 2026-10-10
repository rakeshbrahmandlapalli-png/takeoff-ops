# Parking Ops (takeoff-ops) — notes for the next session

Multi-tenant parking-operations PWA (airport meet & greet). One codebase, several
client companies, each with its own brand and look. Owner: Rakesh (signs in as
owner; also the platform admin, "Parking Ops").

## Where things are
- `public/` — the whole app, no build step: `index.html`, `app.js` (~4.5k lines,
  one IIFE), `app.css` (Standard), look stylesheets (below), `reader.js` (booking
  PDF/Excel reader), `pt.html/pt.js` (PT photo link page), `sw.js` (offline cache;
  **bump `CACHE` when adding a file to `FILES`**).
- `setup/NN-*.sql` — database parts, applied in order to the live DB. Latest: **78** (78 (PICKS car: Return flight `set_pick_flight`, carried to its DROPS car when that has none, logged FLIGHT so imports keep it; office changes the return `set_pick_return`, its DROPS car follows via `set_return`) written 10 Oct, **not applied yet** (waits for the user); 77 (yard colours, `set_yard_colours` owners only; APB starts MY green, GS orange, T yellow) applied by Claude on 10 Oct at the user's request; 76 (exit fee, `set_exit_fee` owners only, `set_exit_paid` with photo) applied by Claude on 10 Oct at the user's request; 75 (EARLY RETURN on a night picked: `early_return(uuid, date)`, `early_return_from_picks(uuid, date)`; the one-argument versions mean tonight) and 74 (EARLY RETURN from the PICKS car) applied by Claude on 10 Oct at the user's request; all applied; the Supabase MCP's execute_sql hangs on DROP statements (asks for a confirmation), so avoid DROP in tests; 73 (dashboard counts DROPS yards, DROPS yard fills empty PICKS location) by Claude on 8 Oct at the user's request; 72 (Operations look) by Claude on 7 Oct at the user's request; 70 and 71 (capacity) by Claude on 7 Oct at the user's request; 68 and 69 run by the user in the SQL editor on 7 Oct — they prefer running SQL themselves; DB checks: checks/carry-from-picks.mjs, checks/desk-booking.mjs, checks/drops-yard-to-picks.mjs, checks/yard-colours.mjs, checks/picks-return-flight.mjs).
- `supabase/functions/` — edge functions (flights, manage-staff, pt-photos, pt-r2,
  send-alerts, staff-login, takeoff-bookings).
- `checks/` — tests (see `checks/README.md`).
- `public/tutorials/` — the 7 how-to videos (owner, terminal, bongo); played from Menu → Tutorials (not cached by `sw.js`); see its README.
- Hosting: Vercel (`takeoff-ops.vercel.app` TakeOff, `parkingbay-ops.vercel.app`
  Airport Parking Bay), deploys from `main`. Phones fetch the new app network-first.
- Supabase project **`oioqjfrlwrjovnouhusp`** ("Ops", Pro plan).

## Clients (companies.brand)
| Client | Look (`brand.theme`) | Brand colour |
|---|---|---|
| TAKEOFF (`takeoff`) | `stdplus` (Standard with features) | amber `#F9A01B` |
| Airport Parking Bay (`airport-parking-bay`) | `premium` | blue `#1560BD` |
| Parking Ops (platform) | standard | — |
Looks are switched on the platform page: Clients → Edit → LOOK
(`admin_save_client` validates the allowed list — add new themes there via a new
setup part).

## The seven looks — each its own stylesheet, never sharing styles
| Label | theme | html class | CSS |
|---|---|---|---|
| Standard | (none) | — | `app.css` |
| Airport Parking Bay UI | `pro` | `pro` | `pro.css` |
| Cards (light and dark) | `cards` | `cards` | `cards.css` |
| Premium UI | `premium` | `premium` | `premium.css` (big cards) |
| Premium Board | `board` | `premium` + `pboard` | `premium.css` + `board.css` (rows exactly like Standard) |
| Standard with features | `stdplus` | `stdplus` | `app.css` + `stdplus.css` |
| Operations | `ops` | `stdplus` + `ops` | `app.css` + `stdplus.css` + `ops.css` (navy/grey chrome from the 7 Oct TakeOff preview; Drops | Picks in the top bar, the day picker then lists only that kind; job rows stay exactly Standard's and the first row must start no lower than in Standard with features, tests check both; Hourly stats is a page (view `stats`, `renderStats`) and Shift summary uses panels — `opsStrip/opsPanel/opsTable`; Menu and the car panel ("Booking details", `#panel.ops-car`) are full pages between the top and bottom bars; Staff & access (`opsStaff`), Flights (`opsFlights`) and Settings have their own ops layouts; other looks get the exact old HTML via `L()/fld()/opsSec()/boxTitle()`) |
JS helpers: `isCards()` (cards or premium = card layout), `isPremium()`,
`isBoard()`, `isStdPlus()` (stdplus or ops), `hasFeatures()` (= Premium looks or stdplus/ops).
The user wants looks kept **separate** (a change to one must not change another).

## Features (gated by `hasFeatures()`: Premium, Premium Board, Standard with features, Operations)
- Bottom nav bar (Board, Flights/Returns, Stats, Summary, Menu).
- Swipe on **drops** only: right and left, each person's own choice on their phone
  (Menu → "Swipe right/left on drops": Off/Sent/Called/Clear). localStorage keys
  `takeoff_swipe` (default from role: bongo→sent, office→called, terminal→clear,
  others off), `takeoff_swipe_left` (default off), `takeoff_swipe_only`
  ("Show buttons on drops" switch off = hide drop buttons; rows show what's done,
  tapping the reg opens the car with STEPS buttons to undo). Swipe only marks,
  never unmarks.
- Pull down to refresh; "Hide numbers" fold (`takeoff_tally_folded`).
- Menu in sections with icons; Delete this sheet alone at the bottom (it confirms).
- Summary: progress bar, activity by day with chips/search/coloured dots, picks
  "Cars in by hour" bars.
- Location on PICKS (per client, Clients → Edit, `brand.picks_yard`): picks rows get a YARD button instead of NO SHOW (NO SHOW in the car panel), yard counts under the numbers. Anyone who takes cars in can set it (setup 67).
- Exit fee (Settings → Exit fee, **owners only**, `companies.exit_fee` / `exit_free`, setup 76): references starting with a listed code (letters and numbers only, any case) get a green NO EXIT FEE tag on DROPS rows. Other DROPS cars get an EXIT FEE box in the car panel: 📷 CASH / 📷 CARD take a photo of the payment (pt-photos <company>/docs/<booking>/x<time>.jpg, 90 days) and mark it paid (`set_exit_paid`, anyone who can CLEAR); "Cash/Card, no photo" links; the row then shows EXIT £10 CASH. Nothing shows while no fee is set.
- Flight APIs: FlightRadar24 (`FR24_TOKEN`) for the timer and Check flights; AeroDataBox (`AERODATABOX_KEY`, RapidAPI PRO, monthly quota ran out 10 Oct) **only** from Flights → "Fill times · AeroData". The timer never calls AeroData (Settings' timetable interval is gone; `schedule_every_hours` is still saved but unused). Test: `node checks/flight-sources.mjs`.
- PICKS car (every look): RETURN FLIGHT box (anyone who takes cars in or does flights), shown on the row after the drop time; the office also gets BACK DATE AND TIME there (setup 78).
- Yard colours (Settings → Yard colours, **owners only**, `companies.yard_colours`, setup 77): each yard's tag on DROPS rows, the PICKS location button and the car's yard buttons filled with the colour (`applyYardColours` writes `<style id=yardColours>`); a yard with no colour keeps the look's own. Every look.
- Key check (every look but the card ones, DROPS boards, everyone but view-only): **K** beside TO DO / ALL. While on, each drop gets a tick box (`keyBox`) and its yard tag goes grey (`kgrey`) until ticked (key found in the cabinet). The grey stays with K off while any key on the sheet is ticked (`keyGrey`); K on shows "Key check · Untick all" above the list to end it. The button counts "K n/N" cars on site. Ticks and the switch are on the phone only (localStorage `takeoff_keys` per sheet, `takeoff_keymode`); sharing them between phones would need a DB part. A separate Key check page was tried and parked by the user.
- Dashboard (owner/manager, Menu → OFFICE): parked now by return day, desk adds, money taken/owed/left unpaid, removed, complaints (`owner_dashboard`, setup 66).
- PICKS "+ New booking at the desk" (everyone but view-only): quick form with a docket photo (camera), NEW BOOKING, taken in, location; photo in pt-photos at <company>/docs/<booking>/, kept 90 days, shown in the car panel (also on its DROPS car by ref). Setup 69.
- Every look: menu bottom shows "App version <etag> · up to date" or
  "New version ready · Update now".

## Rules the app keeps
- Roles: owner, manager, office, bongo (driver), terminal, view. Permissions via `can()`.
- A drop is done when SENT and CLEAR. **"TO DO (N)" counts cars not yet SENT**
  (`waiting()`), not the list length — the user asked to keep it that way.
- DROPS day ends at `drops_day_end` (06:00); PICKS by meet day.

## How we work (user's preferences)
- Build on branch `claude/happy-einstein-ih46nt`. Show **previews** (Playwright
  screenshots via SendUserFile) before merging; merge only when the user says
  "merge it". Squash-merge the PR, then reset the branch to `origin/main` and
  force-push it (it only carries merged history).
- Keep UI text short; the user removed explanatory notes in the menu (keep only
  the Display note).
- Tests: `cd checks/e2e && timeout 580 node run.mjs` — **695 passing** as of 10 Oct
  2026. Add tests for every change. Write output to a file and grep `FAIL|passed`.
  The mock Supabase lives in run.mjs (`rpc()` cases, REST routes).
  Previews: `SHOTS=<dir> node run.mjs` screenshots TakeOff's look (phone and desktop).
  Stress: `STRESS=1 node run.mjs` (36 checks) and `node checks/stress-joblist.cjs`. The board
  re-renders only changed rows (`setMain` + `boardChunks`); keep row HTML one element per row.
- New DB part: copy the previous `admin_save_client` part, change only what's
  needed, check the live definition matches the previous part first, apply with
  the Supabase MCP, keep the file in `setup/`.
- Commit trailer: `Co-Authored-By` + `Claude-Session` lines (see system reminder).
- Do **not** build automated login/scraping of TakeOff's Swift booking admin
  site; that was declined. `supabase/functions/takeoff-bookings` exists but is
  switched off (no config).
- Unused: `companies.swipe_only` / `set_swipe_only()` (setup 64, superseded by
  per-person choice).

## Open ideas the user may ask for next
Swipe on picks; dark-mode check of Premium Board rows; "Next up" strip; long-wait
alert (Called > 20 min, optional Discord ping); shift handover note; search by part
of a reg; owner dashboard (cars/night, Called→Sent wait, no-shows, overstay income);
customer texts (~4p each); automatic import for Airport Parking Bay if they have an
export/API.
