// Supabase Edge Function: flights
//
// Fills in flight times on DROPS cars, the same two ways the Google Sheet did:
//
//   (All timings below are the defaults; owners and managers change them in
//   the app under Settings, stored in companies.flight_settings.)
//
//   SCHEDULE (AeroDataBox)  every 2 h, and right after an import.
//     The published timetable for the day: scheduled landing, cancellations,
//     "the airline has moved it later" before the plane has even left, and
//     the real landing time once it's down. ~3 calls per day sheet.
//
//   LIVE (FlightRadar24)    every 30 min, 06:00 to midnight.
//     Where the aircraft actually is, and its ETA. Credits are charged per
//     RESULT, so only flights near their landing time are asked about
//     (90 min before until 5 h after), only for cars not yet handed back,
//     and only arrivals into our airport. A flight due within the hour with
//     no aircraft in the air is marked DELAY.
//
// Called three ways (POST JSON):
//   { action: "timer" }  by the database timer every 10 min, with the x-timer
//                        header. Decides for itself whether a check is due.
//   { action: "check" }  by the office's "Check now" button, with their sign-in.
//                        Needs the "flights" permission; at most every 3 min.
//   { action: "timetable", day }  by "Fill & check scheduled times": the
//                        AeroDataBox half only, for the sheet on screen (no
//                        FR24 credits). Same permission; at most every 2 min.
//
// Secrets (Edge Functions → Secrets): FR24_TOKEN, AERODATABOX_KEY. Either can
// be missing; that half is skipped and the Flights screen says so.
// "Verify JWT" must be OFF (the timer has no sign-in); callers are checked here.
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// ── rules (measured on the Sheet in Aug 2026; see TAKEOFF-COMPLETE-UPDATED.gs) ──
// Timings are set in the app (Settings, owner and manager) and stored on the
// company; these are the defaults the Sheet ran on.
type Timing = { enabled: boolean; live_every_min: number; schedule_every_hours: number; active_from: number; active_to: number; before_min: number; after_hours: number };
const DEFAULT_TIMING: Timing = { enabled: true, live_every_min: 30, schedule_every_hours: 2, active_from: 6, active_to: 24, before_min: 90, after_hours: 5 };
const timingOf = (c: Company): Timing => ({ ...DEFAULT_TIMING, ...(c.flight_settings ?? {}) });
const SLACK_MIN = 2;   // the timer wakes every 10 min, a little late at times
const BUTTON_GAP_MIN = 3;
const DELAY_WITHIN = 60, DELAY_AFTER = 20;
const MIN_DELAY = 15, MAX_DELAY = 360, MAX_EARLY = 60, MIN_FLIGHT = 20;
const FR24_BATCH = 15, FR24_GAP_MS = 6500, FR24_MAX_CALLS = 6;
const AERO_GAP_MS = 1200;
// On a car whose flight number isn't among the day's arrivals: usually the
// customer gave the outbound flight, or a typo. The app shows it on the row.
const NOT_FOUND = "Not in the timetable · check the flight number";

type Company = { id: string; name: string; time_zone: string; drops_day_end: string; airport_iata: string; airport_icao: string; flight_settings?: Partial<Timing> };
type Booking = {
  id: string; company_id: string; sheet_id: string; ref: string; reg: string; name: string; flight: string;
  return_at: string | null; cleared_at: string | null; overstay: boolean;
  sched_at: string | null; sched_time: string; est_at: string | null; est_time: string;
  flight_status: string; flight_note: string;
};

// ── flight numbers ────────────────────────────────────────────────────
// easyJet is U2 2464 on a booking and EZY2464 as a callsign: same aircraft.
const AIRLINE_ALIAS: Record<string, string> = {
  EZY: "U2", EJU: "EC", RYR: "FR", RUK: "RK", WZZ: "W6", WUK: "W9", EXS: "LS", TOM: "BY", BAW: "BA",
  VIR: "VS", EIN: "EI", SXS: "XQ", PGT: "PC", THY: "TK", VLG: "VY", TRA: "HV", AEE: "A3", ISR: "6H",
  KLM: "KL", DLH: "LH", AFR: "AF", SWR: "LX", AUA: "OS", BEL: "SN", TAP: "TP", IBE: "IB", AEA: "UX",
  LOT: "LO", SAS: "SK", QTR: "QR", UAE: "EK",
};
const norm = (v: unknown) => String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const isIata = (k: string) => /^[A-Z0-9]{2}\d{1,4}$/.test(k);
const isCallsign = (k: string) => /^[A-Z]{3}\d{1,4}$/.test(k);
const looksLikeFlight = (k: string) => isIata(k) || isCallsign(k);
function canon(v: unknown) {
  const k = norm(v), m = /^([A-Z]{3})(\d{1,4})$/.exec(k);
  if (m && AIRLINE_ALIAS[m[1]]) return AIRLINE_ALIAS[m[1]] + m[2];
  // "U2 02314" and "U22314" are the same flight.
  const n = /^([A-Z0-9]{2})0+(\d{1,4})$/.exec(k);
  return n ? n[1] + n[2] : k;
}

// ── time ──────────────────────────────────────────────────────────────
const MIN = 60000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function localParts(d: Date, tz: string) {
  const p: Record<string, string> = {};
  new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(d).forEach((x) => { p[x.type] = x.value; });
  const hour = p.hour === "24" ? "00" : p.hour;
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${hour}:${p.minute}`, hour: Number(hour) };
}
const hhmm = (d: Date, tz: string) => localParts(d, tz).time;
function addDays(day: string, n: number) { const d = new Date(day + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
// "2026-08-29 17:00Z" / "2026-08-29T17:00:00Z" / "2026-08-29 18:00+01:00"
function parseApiTime(v: unknown): Date | null {
  const s = String(v ?? "").trim(); if (!s) return null;
  const d = new Date(s.replace(" ", "T"));
  return isNaN(d.getTime()) ? null : d;
}
const minsBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / MIN;

// The DROPS sheet for the shift running now (runs to drops_day_end next morning).
function shiftDay(c: Company, now: Date) {
  const l = localParts(now, c.time_zone), end = String(c.drops_day_end || "06:00").slice(0, 5);
  return l.time <= end ? addDays(l.day, -1) : l.day;
}

// ── AeroDataBox: the timetable ────────────────────────────────────────
type Arrival = { keys: string[]; number: string; origin: string; codeshare: boolean; sched: Date | null; cancelled: boolean; late: Date | null; why: string; landed: Date | null };

async function aeroFetch(key: string, airport: string, from: string, to: string) {
  const url = `https://aerodatabox.p.rapidapi.com/flights/airports/iata/${airport}/${from}/${to}?direction=Arrival&withLeg=true&withCancelled=true&withCodeshared=true&withLocation=false`;
  const opts = { headers: { "x-rapidapi-key": key, "x-rapidapi-host": "aerodatabox.p.rapidapi.com" } };
  let res = await fetch(url, opts);
  if (res.status === 429) { await sleep(AERO_GAP_MS * 2); res = await fetch(url, opts); }   // per-second limit
  if (res.status === 204) return [];
  const text = await res.text();
  if (!res.ok) throw new Error(`AeroDataBox ${res.status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text || "{}");
  return (json.arrivals ?? []) as Record<string, any>[];
}

// Every arrival from 05:00 on the sheet's day for 26 hours, in 12-hour chunks
// (the API refuses longer ranges). Times asked for are the airport's local time.
async function aeroDay(key: string, c: Company, day: string): Promise<Arrival[]> {
  const next = addDays(day, 1);
  const windows = [[`${day}T05:00`, `${day}T17:00`], [`${day}T17:00`, `${next}T05:00`], [`${next}T05:00`, `${next}T07:00`]];
  const out: Arrival[] = [];
  for (let i = 0; i < windows.length; i++) {
    if (i) await sleep(AERO_GAP_MS);
    for (const f of await aeroFetch(key, c.airport_iata, windows[i][0], windows[i][1])) {
      const leg = f.movement ?? f.arrival ?? {};
      const num = String(f.number ?? "");
      const keys = new Set<string>();
      const k = canon(num); if (looksLikeFlight(k)) keys.add(k);
      const digits = /(\d{1,4})\s*$/.exec(num), icao = f.airline?.icao;
      if (icao && digits) { const alt = canon(String(icao).toUpperCase() + digits[1]); if (looksLikeFlight(alt)) keys.add(alt); }
      if (!keys.size) continue;

      const sched = parseApiTime(leg.scheduledTime?.utc);
      const cancelled = /^cancel/i.test(String(f.status ?? ""));

      // Landed: fact, not forecast. A plane can't land before it took off —
      // AeroDataBox once reported FR9630 arrived while still in Barcelona.
      let landed = parseApiTime(leg.actualTime?.utc ?? leg.runwayTime?.utc);
      const dep = f.departure ?? null;
      const depOff = dep ? parseApiTime(dep.actualTime?.utc ?? dep.revisedTime?.utc) : null;
      if (landed && depOff && minsBetween(depOff, landed) < MIN_FLIGHT) landed = null;

      // Running late: the airline's revised arrival, or its departure delay
      // carried forward, whichever is LATER (the arrival revision lags).
      let late = parseApiTime(leg.revisedTime?.utc ?? leg.predictedTime?.utc);
      let why = late ? "airline estimate" : "";
      if (sched && dep) {
        const depSched = parseApiTime(dep.scheduledTime?.utc);
        if (depSched && depOff) {
          const off = Math.round(minsBetween(depSched, depOff));
          if (off >= MIN_DELAY && (!late || sched.getTime() + off * MIN > late.getTime())) {
            late = new Date(sched.getTime() + off * MIN); why = `departed ${off} min late`;
          }
        }
      }
      out.push({ keys: [...keys], number: canon(num), origin: String(dep?.airport?.municipalityName ?? dep?.airport?.name ?? dep?.airport?.iata ?? ""),
        codeshare: /codeshared/i.test(String(f.codeshareStatus ?? "")), sched, cancelled, late, why, landed });
    }
  }
  return out;
}

// ── FlightRadar24: where the aircraft is ──────────────────────────────
async function fr24Live(token: string, c: Company, keys: string[], param: "flights" | "callsigns") {
  const qs = new URLSearchParams({ [param]: keys.join(","), airports: `inbound:${c.airport_iata}` });
  const res = await fetch(`https://fr24api.flightradar24.com/api/live/flight-positions/full?${qs}`, {
    headers: { Accept: "application/json", "Accept-Version": "v1", Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`FR24 ${res.status}: ${text.slice(0, 200)}`);
  return (JSON.parse(text || "{}").data ?? []) as Record<string, any>[];
}

// ── one company ───────────────────────────────────────────────────────
async function logRun(admin: SupabaseClient, c: Company, source: string, trigger: string, result: Record<string, unknown>) {
  await admin.from("flight_runs").insert({ company_id: c.id, source, trigger, result });
}
async function lastRun(admin: SupabaseClient, c: Company, source: string) {
  const { data } = await admin.from("flight_runs").select("at").eq("company_id", c.id).eq("source", source).order("at", { ascending: false }).limit(1).maybeSingle();
  return data ? new Date(data.at) : null;
}
async function saveChanges(admin: SupabaseClient, changes: Map<string, Record<string, unknown>>) {
  for (const [id, patch] of changes) {
    const { error } = await admin.from("bookings").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
    if (error) throw new Error(error.message);
  }
}
function patchOf(changes: Map<string, Record<string, unknown>>, b: Booking) {
  let p = changes.get(b.id); if (!p) { p = {}; changes.set(b.id, p); }
  return p;
}

async function checkSchedule(admin: SupabaseClient, c: Company, days: string[], trigger: string) {
  const key = Deno.env.get("AERODATABOX_KEY");
  if (!key) return { skipped: "No AeroDataBox key yet" };
  const now = new Date(), tz = c.time_zone;
  const tally = { filled: 0, moved: 0, expected: 0, landed: 0, cancelled: 0, notfound: 0, sheets: 0, error: "" };

  for (const day of days) {
    const { data: sheet } = await admin.from("sheets").select("id").eq("company_id", c.id).eq("kind", "drops").eq("day", day).maybeSingle();
    if (!sheet) continue;
    const { data: rows, error } = await admin.from("bookings").select("*").eq("sheet_id", sheet.id);
    if (error) throw new Error(error.message);
    if (!rows?.length) continue;
    // Overstays keep an old day's flight number: today's run of it is a different plane.
    const cars = (rows as Booking[]).filter((b) => b.flight && !b.overstay && looksLikeFlight(canon(b.flight)));
    tally.sheets++;

    let arrivals: Arrival[];
    try { arrivals = await aeroDay(key, c, day); }
    catch (err) { tally.error = (err as Error).message; continue; }

    // Keep the day's arrivals, so a car with no flight number can be offered
    // the flights landing near its booked time (part 7; skipped if not run).
    const seen = new Set<string>();
    const table = arrivals.filter((a) => a.sched && !a.codeshare && looksLikeFlight(a.number)).map((a) => ({
      company_id: c.id, flight: a.number, sched_at: a.sched!.toISOString(), origin: a.origin.slice(0, 60),
      status: a.cancelled ? "cancelled" : "", updated_at: new Date().toISOString(),
    })).filter((r) => { const k = r.flight + r.sched_at; if (seen.has(k)) return false; seen.add(k); return true; });
    if (table.length) {
      const { error: tErr } = await admin.from("timetable").upsert(table, { onConflict: "company_id,flight,sched_at" });
      if (tErr && !/timetable/.test(tErr.message)) console.error("timetable save failed", tErr.message);
    }

    const changes = new Map<string, Record<string, unknown>>();
    const activity: Record<string, unknown>[] = [];
    for (const b of cars) {
      const k = canon(b.flight), booked = b.return_at ? new Date(b.return_at) : null;
      const runs = arrivals.filter((a) => a.keys.includes(k));
      const flag = (note: string) => {
        tally.notfound++;
        if (!b.flight_status && !b.sched_at && b.flight_note !== note) patchOf(changes, b).flight_note = note;
      };
      if (!runs.length) { flag(NOT_FOUND); continue; }
      // A daily number appears more than once in 26 hours: take the run
      // nearest the time the customer booked, and never one 6 h away.
      const timed = runs.filter((a) => a.sched && (!booked || Math.abs(minsBetween(booked, a.sched!)) <= MAX_DELAY))
        .sort((x, y) => booked ? Math.abs(minsBetween(booked, x.sched!)) - Math.abs(minsBetween(booked, y.sched!)) : 0);
      const run = timed[0] ?? (runs.every((a) => a.cancelled) ? runs[0] : null);
      if (!run) {
        const near = runs.find((a) => a.sched);
        flag(near ? `Lands ${hhmm(near.sched!, tz)}, over 6 h from the booked time · check the flight number` : NOT_FOUND);
        continue;
      }

      if (run.cancelled) {
        if (b.flight_status !== "cancelled") {
          Object.assign(patchOf(changes, b), { flight_status: "cancelled", flight_note: `Cancelled · timetable, checked ${hhmm(now, tz)}` });
          activity.push({ company_id: c.id, staff_name: "Flights", sheet_id: b.sheet_id, booking_id: b.id, reg: b.reg, customer: b.name, action: "CANCELLED", value: b.flight });
          tally.cancelled++;
        }
        continue;
      }
      if (!run.sched) continue;

      const p = patchOf(changes, b);
      if (/check the flight number$/.test(b.flight_note)) p.flight_note = "";
      if (!b.sched_at || new Date(b.sched_at).getTime() !== run.sched.getTime()) {
        Object.assign(p, { sched_at: run.sched.toISOString(), sched_time: hhmm(run.sched, tz) });
        if (b.sched_at) tally.moved++; else tally.filled++;
        if (!b.flight_status || b.flight_status === "cancelled") p.flight_status = "scheduled";
      }

      if (run.landed && b.flight_status !== "landed") {
        Object.assign(p, { est_at: run.landed.toISOString(), est_time: hhmm(run.landed, tz), flight_status: "landed", flight_note: `Landed ${hhmm(run.landed, tz)} · timetable feed` });
        tally.landed++;
        continue;
      }
      // Never argue with a live FR24 reading or a landing.
      const free = ["", "scheduled", "expected", "delayed", "cancelled"].includes(b.flight_status);
      const off = run.late ? minsBetween(run.sched, run.late) : 0;
      if (free && run.late && off >= MIN_DELAY && off <= MAX_DELAY && b.est_at !== run.late.toISOString()) {
        Object.assign(p, { est_at: run.late.toISOString(), est_time: hhmm(run.late, tz), flight_status: "expected", flight_note: `Expected ${hhmm(run.late, tz)} (${run.why})` });
        tally.expected++;
      }
      if (!Object.keys(p).length) changes.delete(b.id);
    }
    await saveChanges(admin, changes);
    if (activity.length) await admin.from("activity").insert(activity);
  }
  await logRun(admin, c, "schedule", trigger, tally);
  return tally;
}

async function checkLive(admin: SupabaseClient, c: Company, day: string, trigger: string) {
  const token = Deno.env.get("FR24_TOKEN");
  if (!token) return { skipped: "No FlightRadar24 token yet" };
  const now = new Date(), tz = c.time_zone, stamp = hhmm(now, tz), T = timingOf(c);
  const tally = { looked: 0, calls: 0, written: 0, delayed: 0, landed: 0, error: "" };

  const { data: sheet } = await admin.from("sheets").select("id").eq("company_id", c.id).eq("kind", "drops").eq("day", day).maybeSingle();
  if (!sheet) { await logRun(admin, c, "live", trigger, { ...tally, note: "No DROPS sheet for " + day }); return tally; }
  const { data: rows, error } = await admin.from("bookings").select("*").eq("sheet_id", sheet.id).neq("flight", "").is("cleared_at", null);
  if (error) throw new Error(error.message);

  const changes = new Map<string, Record<string, unknown>>();
  const wanted = new Map<string, Booking[]>();
  for (const b of rows as Booking[]) {
    const k = canon(b.flight);
    if (b.overstay || !looksLikeFlight(k) || ["landed", "cancelled"].includes(b.flight_status)) continue;
    // An ETA that has passed with the aircraft gone from the feed: it's down.
    // Costs nothing to work out.
    if (b.flight_status === "airborne" && b.est_at && new Date(b.est_at) < now) {
      Object.assign(patchOf(changes, b), { flight_status: "landed", flight_note: `Landed about ${b.est_time} (last ETA)` });
      tally.landed++; continue;
    }
    const tracked = ["airborne", "expected"].includes(b.flight_status) && b.est_at;
    const anchor = new Date((tracked ? b.est_at : b.sched_at ?? b.return_at) ?? 0);
    if (!anchor.getTime()) continue;
    const toGo = minsBetween(now, anchor);
    if (toGo > T.before_min || toGo < -T.after_hours * 60) continue;     // not worth a credit yet
    if (!wanted.has(k)) wanted.set(k, []);
    wanted.get(k)!.push(b);
  }

  const keys = [...wanted.keys()];
  tally.looked = keys.length;
  const hits = new Map<string, Date>();
  const groups: { param: "flights" | "callsigns"; keys: string[] }[] = [];
  for (let i = 0; i < keys.length; i += FR24_BATCH) {
    const chunk = keys.slice(i, i + FR24_BATCH);
    // EZY612 must go as a callsign; one malformed entry rejects the whole request.
    groups.push({ param: "flights", keys: chunk.filter(isIata) }, { param: "callsigns", keys: chunk.filter((k) => !isIata(k) && isCallsign(k)) });
  }
  const want = [c.airport_iata, c.airport_icao].map((x) => String(x || "").toUpperCase()).filter(Boolean);
  for (const g of groups.filter((x) => x.keys.length)) {
    if (tally.calls >= FR24_MAX_CALLS) { tally.error = "Stopped at the per-run call limit"; break; }
    if (tally.calls) await sleep(FR24_GAP_MS);   // plan allows 10 requests a minute
    tally.calls++;
    try {
      for (const rec of await fr24Live(token, c, g.keys, g.param)) {
        const k = [canon(rec.flight), canon(rec.callsign)].find((x) => x && wanted.has(x));
        if (!k || hits.has(k)) continue;
        const dest = [rec.dest_iata, rec.dest_icao, rec.dest_icao_actual].map((v) => String(v || "").toUpperCase()).filter(Boolean);
        if (dest.length && !dest.some((d) => want.includes(d))) continue;   // wrong leg
        const eta = parseApiTime(rec.eta ?? rec.eta_utc);
        if (!eta) continue;
        const ahead = minsBetween(now, eta);
        if (ahead < -60 || ahead > 900) continue;
        hits.set(k, eta);
      }
    } catch (err) { tally.error = (err as Error).message; }
  }

  for (const [k, cars] of wanted) {
    const eta = hits.get(k);
    for (const b of cars) {
      const p = patchOf(changes, b);
      p.flight_checked_at = now.toISOString();
      const base = new Date((b.sched_at ?? b.return_at)!);
      if (eta && minsBetween(base, eta) >= -MAX_EARLY && minsBetween(base, eta) <= MAX_DELAY) {
        Object.assign(p, { est_at: eta.toISOString(), est_time: hhmm(eta, tz), flight_status: "airborne", flight_note: `ETA · FR24, checked ${stamp}` });
        tally.written++;
      } else if (!eta && ["", "scheduled", "delayed"].includes(b.flight_status)) {
        // Only a delay if it ought to be in the air by now. Well past the time,
        // "no aircraft" more likely means it has already landed.
        const due = minsBetween(now, base);
        if (due <= DELAY_WITHIN && due >= -DELAY_AFTER) {
          if (b.flight_status !== "delayed") tally.delayed++;
          Object.assign(p, { est_at: null, est_time: "DELAY", flight_status: "delayed", flight_note: `Not airborne at ${stamp}, so it will be late` });
        } else if (b.flight_status === "delayed") {
          Object.assign(p, { est_time: "", flight_status: b.sched_at ? "scheduled" : "", flight_note: "" });
        }
      }
    }
  }
  await saveChanges(admin, changes);
  await logRun(admin, c, "live", trigger, tally);
  return tally;
}

async function runCompany(admin: SupabaseClient, c: Company, trigger: "timer" | "button") {
  const now = new Date(), today = shiftDay(c, now), tomorrow = addDays(today, 1), T = timingOf(c);
  if (trigger === "timer" && !T.enabled) return { company: c.name, skipped: "Flight checks are switched off in Settings" };
  const out: Record<string, unknown> = { company: c.name, day: today };

  // Timetable: every 2 h, or sooner when a sheet was imported since the last one.
  const lastSched = await lastRun(admin, c, "schedule");
  const { data: fresh } = await admin.from("sheets").select("id").eq("company_id", c.id).eq("kind", "drops")
    .in("day", [today, tomorrow]).gt("imported_at", (lastSched ?? new Date(0)).toISOString()).limit(1);
  const schedDue = !lastSched || minsBetween(lastSched, now) >= T.schedule_every_hours * 60 - SLACK_MIN || !!fresh?.length;
  const recent = lastSched && minsBetween(lastSched, now) < 15;
  if (schedDue || (trigger === "button" && !recent)) out.schedule = await checkSchedule(admin, c, [today, tomorrow], trigger);

  // Live: every 30 min in working hours; the button any time.
  const lastLive = await lastRun(admin, c, "live");
  const hour = localParts(now, c.time_zone).hour;
  // 22 to 6 is allowed too: a window that runs over midnight.
  const inHours = T.active_from < T.active_to ? hour >= T.active_from && hour < T.active_to : hour >= T.active_from || hour < T.active_to;
  if (trigger === "button" || (inHours && (!lastLive || minsBetween(lastLive, now) >= T.live_every_min - SLACK_MIN))) {
    out.live = await checkLive(admin, c, today, trigger);
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "POST only." });

  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { body = {}; }

  try {
    if (body.action === "timer") {
      const { data: ok } = await admin.rpc("timer_secret_ok", { p_secret: req.headers.get("x-timer") ?? "" });
      if (ok !== true) return reply(403, { error: "Not the timer." });
      if (!Deno.env.get("FR24_TOKEN") && !Deno.env.get("AERODATABOX_KEY")) return reply(200, { skipped: "No flight keys yet" });
      const { data: companies } = await admin.from("companies").select("*");
      const results = [];
      for (const c of (companies ?? []) as Company[]) {
        try { results.push(await runCompany(admin, c, "timer")); }
        catch (err) { results.push({ company: c.name, error: (err as Error).message }); }
      }
      return reply(200, { results });
    }

    if (body.action === "check" || body.action === "timetable") {
      const asCaller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
        auth: { persistSession: false }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
      });
      const [{ data: companyId }, { data: allowed }] = await Promise.all([asCaller.rpc("my_company"), asCaller.rpc("can", { p_action: "flights" })]);
      if (!companyId) return reply(401, { error: "Sign in again." });
      if (allowed !== true) return reply(403, { error: "Only the office can check flights." });
      const { data: c } = await admin.from("companies").select("*").eq("id", companyId).single();
      if (body.action === "timetable") {
        const day = String(body.day ?? "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return reply(400, { error: "Choose a DROPS sheet first." });
        if (!Deno.env.get("AERODATABOX_KEY")) return reply(200, { schedule: { skipped: "No AeroDataBox key yet" } });
        const lastT = await lastRun(admin, c as Company, "schedule");
        if (lastT && lastT.getTime() > Date.now() - 2 * MIN) return reply(429, { error: "Timetable checked under 2 min ago. Try again in a minute." });
        return reply(200, { schedule: await checkSchedule(admin, c as Company, [day], "button") });
      }
      const last = await lastRun(admin, c as Company, "live");
      if (last && last.getTime() > Date.now() - BUTTON_GAP_MIN * MIN) {
        return reply(429, { error: `Checked ${Math.max(0, Math.round((Date.now() - last.getTime()) / MIN))} min ago. Try again in a few minutes (each check uses paid credits).` });
      }
      return reply(200, await runCompany(admin, c as Company, "button"));
    }

    return reply(400, { error: "Unknown action." });
  } catch (err) {
    return reply(500, { error: (err as Error).message ?? String(err) });
  }
});
