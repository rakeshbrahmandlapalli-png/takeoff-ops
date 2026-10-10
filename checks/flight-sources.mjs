// Which flight APIs each way of calling the flights edge function uses, with a
// pretend database and pretend APIs (no network, no Deno needed):
//   node checks/flight-sources.mjs
// The timer and "Check flights" use FlightRadar24 only; AeroDataBox (AeroData)
// is called only by "Fill times", at most once per sheet per 10 min, and not
// at all for 6 h after it says the month's quota is spent.
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { execFileSync } from "child_process";

if (!process.env.FLIGHT_SOURCES_CHILD) {
  // Node strips the TypeScript types; needs the flag on Node 22.
  try { execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url)], { stdio: "inherit", env: { ...process.env, FLIGHT_SOURCES_CHILD: "1" } }); }
  catch { process.exit(1); }
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "../supabase/functions/flights/index.ts"), "utf8")
  .replace(/^import \{ createClient, SupabaseClient \} from .*$/m, "const createClient = (globalThis as any).__createClient; type SupabaseClient = any;");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flights-"));
fs.writeFileSync(path.join(tmp, "index.ts"), src);

// ── pretend database ──
const now = Date.now(), iso = (ms) => new Date(ms).toISOString();
const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(now - 6 * 3600e3));
let db;
function fresh() {
  db = {
    companies: [{ id: "c1", name: "TAKEOFF", slug: "takeoff", time_zone: "Europe/London", drops_day_end: "06:00", airport_iata: "LGW", airport_icao: "EGKK", flight_settings: { schedule_every_hours: 1 }, suspended_at: null }],
    sheets: [{ id: "s1", company_id: "c1", kind: "drops", day, imported_at: iso(now - 60e3) }],
    bookings: [{ id: "b1", company_id: "c1", sheet_id: "s1", ref: "R1", reg: "AB12CDE", name: "A", flight: "U22464", return_at: iso(now + 30 * 60e3), cleared_at: null, overstay: false,
      sched_at: iso(now + 30 * 60e3), sched_time: "", est_at: null, est_time: "", flight_status: "", flight_note: "" }],
    flight_runs: [], timetable: [], activity: [],
  };
}
function q(table) {
  const f = [];
  let lim = Infinity, order = null, op = "select", patch = null;
  const get = (r, c) => { const m = /^(\w+)->>(\w+)$/.exec(c); return m ? (r[m[1]] ?? {})[m[2]] : r[c]; };
  const rows = () => {
    let out = db[table].filter((r) => f.every((t) => t(r)));
    if (order) out = out.slice().sort((a, b) => (a[order.c] < b[order.c] ? -1 : 1) * (order.asc ? 1 : -1));
    return out.slice(0, lim);
  };
  const run = () => {
    if (op === "update") { rows().forEach((r) => Object.assign(r, patch)); return { data: null, error: null }; }
    return { data: rows(), error: null };
  };
  const b = {
    select() { return b; },
    eq(c, v) { f.push((r) => String(get(r, c)) === String(v)); return b; },
    neq(c, v) { f.push((r) => get(r, c) !== v); return b; },
    is(c, v) { f.push((r) => (get(r, c) ?? null) === v); return b; },
    in(c, v) { f.push((r) => v.includes(get(r, c))); return b; },
    gt(c, v) { f.push((r) => get(r, c) > v); return b; },
    gte(c, v) { f.push((r) => get(r, c) >= v); return b; },
    ilike(c, v) { const re = new RegExp("^" + v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i"); f.push((r) => re.test(String(get(r, c) ?? ""))); return b; },
    order(c, o) { order = { c, asc: o?.ascending !== false }; return b; },
    limit(n) { lim = n; return b; },
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    single: async () => ({ data: rows()[0] ?? null, error: null }),
    update(p) { op = "update"; patch = p; return b; },
    insert: async (v) => { [].concat(v).forEach((r) => db[table].push({ at: iso(Date.now()), ...r })); return { error: null }; },
    upsert: async (v) => { db[table].push(...[].concat(v)); return { error: null }; },
    then: (res, rej) => Promise.resolve(run()).then(res, rej),
  };
  return b;
}
globalThis.__createClient = () => ({ from: q, rpc: async (name) => ({ data: name === "my_company" ? "c1" : true, error: null }) });

// ── pretend APIs ──
let calls, aeroAnswer;
globalThis.fetch = async (url) => {
  const host = new URL(url).host;
  calls[host] = (calls[host] || 0) + 1;
  if (/aerodatabox/.test(host)) return aeroAnswer === "quota"
    ? new Response(JSON.stringify({ message: "You have exceeded the MONTHLY quota for API Units on your current plan, PRO." }), { status: 429 })
    : new Response(JSON.stringify({ arrivals: [] }), { status: 200 });
  return new Response(JSON.stringify({ data: [] }), { status: 200 });
};
let handler;
globalThis.Deno = { env: { get: (k) => ({ SUPABASE_URL: "http://x", SUPABASE_SERVICE_ROLE_KEY: "k", SUPABASE_ANON_KEY: "a", FR24_TOKEN: "t", AERODATABOX_KEY: "a" })[k] }, serve: (h) => { handler = h; } };
await import(pathToFileURL(path.join(tmp, "index.ts")).href);

const addSheet2 = () => { db.sheets.push({ id: "s2", company_id: "c1", kind: "drops", day: "2026-01-02", imported_at: iso(now) }); db.bookings.push({ ...db.bookings[0], id: "b2", sheet_id: "s2" }); };
const post = async (body) => { calls = {}; const r = await handler(new Request("http://x", { method: "POST", body: JSON.stringify(body), headers: { "x-timer": "s" } })); return { status: r.status, json: await r.json(), aero: calls["aerodatabox.p.rapidapi.com"] || 0, fr24: calls["fr24api.flightradar24.com"] || 0 }; };
let failed = 0, passed = 0;
const check = (name, ok, info) => { if (ok) passed++; else failed++; console.log((ok ? "ok   " : "FAIL ") + name + (ok ? "" : " " + JSON.stringify(info))); };

fresh(); aeroAnswer = "ok";
let r = await post({ action: "timer" });
check("timer, with a sheet just imported and the timetable set to every hour: FR24 only, no AeroData", r.aero === 0 && r.fr24 === 1, r);
fresh();
r = await post({ action: "check" });
check("Check flights: FR24 only, no AeroData", r.status === 200 && r.aero === 0 && r.fr24 === 1 && !r.json.schedule, r);
fresh();
r = await post({ action: "timetable", day });
check("Fill times: AeroData only (3 calls for the day), no FR24", r.status === 200 && r.aero === 3 && r.fr24 === 0, r);
r = await post({ action: "timetable", day });
check("Fill times again within 10 min for the same sheet: refused, no calls", r.status === 429 && r.aero === 0 && /AeroData/.test(r.json.error), r);
addSheet2();
r = await post({ action: "timetable", day: "2026-01-02" });
check("Fill times for another sheet: allowed", r.status === 200 && r.aero === 3, r);

fresh(); aeroAnswer = "quota";
r = await post({ action: "timetable", day });
check("monthly quota spent: one call, no retries, the error is shown", r.aero === 1 && /MONTHLY quota/.test(r.json.schedule.error), r);
addSheet2();
r = await post({ action: "timetable", day: "2026-01-02" });
check("after a spent quota: Fill times doesn't call AeroData for 6 h", r.aero === 0 && /used up/.test(r.json.schedule.skipped), r);
db.flight_runs.forEach((x) => { x.at = iso(now - 7 * 3600e3); });
aeroAnswer = "ok";
r = await post({ action: "timetable", day: "2026-01-02" });
check("6 h later Fill times tries AeroData again", r.aero === 3, r);

fresh(); db.bookings[0].flight_status = "landed";
r = await post({ action: "timetable", day });
check("Fill times on a sheet where every flight has landed: no AeroData calls", r.status === 200 && r.aero === 0 && r.json.schedule.done === 1, r);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
