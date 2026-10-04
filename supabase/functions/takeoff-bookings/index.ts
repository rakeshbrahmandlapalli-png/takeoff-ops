// Supabase Edge Function: takeoff-bookings
//
// Logs in to a company's booking admin site (TakeOff → Swift Airport Parking),
// downloads the Booking List (DROPS + PICKS) and the Return Report (flights),
// reads them with the SAME parser the phone uses (reader.mjs), and imports each
// day through import_sheet_system — so the board updates exactly as a manual
// Import does: team's work kept, typed flights win, changed returns move day,
// cancelled bookings left for the office.
//
//   { action: "run" }    a signed-in office/manager presses "Get bookings now";
//                        imports their own company (must have import permission).
//   { action: "timer" }  the 10-minute schedule (x-timer header); loops every
//                        company that has auto-import switched on.
//
// It only VIEWS and DOWNLOADS on the booking site; it never edits anything
// there. One run at a time per company; on trouble it records the error and
// waits for the next run. "Verify JWT" must be OFF (the timer has no sign-in;
// the run action checks the caller here).
//
// Per-company settings live in private.auto_import.config, e.g.
//   { "base": "https://luton.swiftairportparking.co.uk/admin/",
//     "login_path": "index.php?req=login",
//     "login_fields": { "login": "login", "password": "password",
//                       "extra": { "action": "Sign In", "url": "%3F" } },
//     "export_path": "export_to_excel.php",
//     "drops_search": "bookinglist-parkandride.php?...&filter_from={FROM}&filter_to={TO}...",
//     "picks_search": "bookinglist-parkandride.php?...status=Booked...",
//     "flights_search": "arrival_report_parkandride.php?...&filter_from={FROM}&filter_to={TO}...",
//     "flights_export_path": "export_to_excel.php",
//     "drops_days": 2, "picks_days": 10 }
// The login itself is NOT here: it's the Supabase secrets TAKEOFF_BOOKING_LOGIN
// and TAKEOFF_BOOKING_PASSWORD.
import { createClient } from "npm:@supabase/supabase-js@2";
import * as XLSX from "npm:xlsx@0.18.5";
import { parseExcelGrid, matchFlights, groupForImport } from "./reader.mjs";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// London "today" + n days, as the site's date boxes want it ("05-October-2026").
function siteDate(offsetDays: number): string {
  const now = new Date(Date.now() + offsetDays * 864e5);
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "2-digit", month: "numeric", year: "numeric" }).formatToParts(now);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return g("day") + "-" + MONTHS[+g("month") - 1] + "-" + g("year");
}

// ── the booking site ──────────────────────────────────────────────────────
// One cookie jar for the whole run, so we sign in once (gentle on their site).
function cookieJar() {
  const jar: Record<string, string> = {};
  return {
    header: () => Object.entries(jar).map(([k, v]) => k + "=" + v).join("; "),
    store: (res: Response) => {
      // Deno exposes multiple Set-Cookie via getSetCookie().
      const raw = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
      raw.forEach((c) => { const m = c.match(/^([^=]+)=([^;]*)/); if (m) jar[m[1]] = m[2]; });
    },
  };
}

async function login(base: string, cfg: Record<string, unknown>, jar: ReturnType<typeof cookieJar>) {
  const user = Deno.env.get("TAKEOFF_BOOKING_LOGIN") ?? "";
  const pass = Deno.env.get("TAKEOFF_BOOKING_PASSWORD") ?? "";
  if (!user || !pass) throw new Error("No booking login saved (TAKEOFF_BOOKING_LOGIN / _PASSWORD).");
  const f = (cfg.login_fields ?? {}) as { login?: string; password?: string; extra?: Record<string, string> };
  const body = new URLSearchParams();
  body.set(f.login ?? "login", user);
  body.set(f.password ?? "password", pass);
  Object.entries(f.extra ?? { action: "Sign In" }).forEach(([k, v]) => body.set(k, v));
  // First GET sets a session cookie; then POST the credentials.
  const pre = await fetch(base + (cfg.login_path ?? "index.php"), { headers: { cookie: jar.header() }, redirect: "manual" });
  jar.store(pre);
  const res = await fetch(base + (cfg.login_path ?? "index.php?req=login"), {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: body.toString(),
  });
  jar.store(res);
  if (res.status >= 500) throw new Error("Booking site login failed (" + res.status + ").");
}

async function download(base: string, searchPath: string, exportPath: string, jar: ReturnType<typeof cookieJar>): Promise<ArrayBuffer> {
  // Set the session's filter (the export reflects the last search), then export.
  const search = searchPath.replace(/\{FROM\}/g, siteDate(0)).replace(/\{TO\}/g, siteDate(1));
  const s = await fetch(base + search, { headers: { cookie: jar.header() }, redirect: "manual" });
  jar.store(s);
  if (/login|index\.php/i.test(s.headers.get("location") ?? "")) throw new Error("Not logged in (the site bounced to the login page). Check the saved login.");
  const x = await fetch(base + exportPath, { headers: { cookie: jar.header() }, redirect: "manual" });
  if (!x.ok) throw new Error("Download failed (" + x.status + ") for " + exportPath + ".");
  return await x.arrayBuffer();
}

function gridFrom(buf: ArrayBuffer): string[][] {
  // The export is a tab-separated "xls"; SheetJS reads it. Dates are already
  // text ("2026-10-05 15:00") in this export, so no serial-date handling.
  const wb = XLSX.read(new Uint8Array(buf), { type: "array", raw: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return (XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" }) as unknown[][])
    .map((row) => row.map((v) => (v == null ? "" : String(v))));
}

async function runCompany(company: { id: string; slug: string; drops_day_end?: string }, cfgRow: Record<string, unknown>) {
  const cfg = (cfgRow.config ?? {}) as Record<string, unknown>;
  const base = String(cfg.base ?? "");
  if (!base) throw new Error("Auto-import is not set up for " + company.slug + " (no config.base).");
  const exportPath = String(cfg.export_path ?? "export_to_excel.php");
  const jar = cookieJar();
  await login(base, cfg, jar);

  const dropsCut = (company.drops_day_end ?? "06:00").slice(0, 5);
  const horizon = (days: number, dayKey: string) => {
    const limit = new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
    return dayKey <= limit;
  };

  // DROPS + flights
  const dropsGrid = gridFrom(await download(base, String(cfg.drops_search ?? ""), exportPath, jar));
  const drops = parseExcelGrid(dropsGrid).rows;
  if (cfg.flights_search) {
    const fGrid = gridFrom(await download(base, String(cfg.flights_search), String(cfg.flights_export_path ?? exportPath), jar));
    const fRows = parseExcelGrid(fGrid).rows.map((r) => ({ ref: r.ref, reg: r.reg, flight: r.flightIn || r.flightOut }));
    matchFlights(drops, fRows, "flightIn");
  }
  // PICKS
  const picksGrid = gridFrom(await download(base, String(cfg.picks_search ?? ""), exportPath, jar));
  const picks = parseExcelGrid(picksGrid).rows;

  const summary: Record<string, unknown> = { at: new Date().toISOString(), days: [] as unknown[] };
  const dropsDays = Number(cfg.drops_days ?? 2), picksDays = Number(cfg.picks_days ?? 10);
  const doImport = async (rows: typeof drops, kind: "drops" | "picks", days: number) => {
    const groups = groupForImport(rows, kind, dropsCut).filter((g) => horizon(days, g.day));
    for (const g of groups) {
      const res = await admin.rpc("import_sheet_system", {
        p_company: company.id, p_kind: kind, p_day: g.day, p_rows: g.rows,
        p_source: { auto: true, provider: cfgRow.provider ?? "swift", bookings: g.rows.length },
      });
      if (res.error) throw new Error(kind + " " + g.day + ": " + res.error.message);
      (summary.days as unknown[]).push({ kind, day: g.day, ...(res.data as object) });
    }
  };
  await doImport(drops, "drops", dropsDays);
  await doImport(picks, "picks", picksDays);
  summary.drops_rows = drops.length;
  summary.picks_rows = picks.length;
  return summary;
}

async function record(companyId: string, ok: boolean, error: string, summary: unknown) {
  await admin.rpc("auto_import_record", { p_company: companyId, p_ok: ok, p_error: error, p_summary: summary ?? null });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "POST only." });
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body = run */ }
  const action = String(body.action ?? "run");

  try {
    if (action === "timer") {
      const { data: ok } = await admin.rpc("timer_secret_ok", { p_secret: req.headers.get("x-timer") ?? "" });
      if (ok !== true) return reply(403, { error: "Not the timer." });
      const { data: due, error } = await admin.rpc("auto_import_due");
      if (error) throw error;
      const results: unknown[] = [];
      for (const co of (due ?? []) as { id: string; slug: string; drops_day_end?: string }[]) {
        const { data: row } = await admin.rpc("auto_import_row", { p_company: co.id });
        try { const s = await runCompany(co, (row ?? {}) as Record<string, unknown>); await record(co.id, true, "", s); results.push({ slug: co.slug, ok: true }); }
        catch (e) { await record(co.id, false, (e as Error).message, null); results.push({ slug: co.slug, ok: false, error: (e as Error).message }); }
      }
      return reply(200, { ran: results.length, results });
    }

    // action "run": a signed-in office/manager importing their own company.
    const auth = req.headers.get("authorization") ?? "";
    if (!auth) return reply(401, { error: "Sign in first." });
    const asUser = createClient(SB_URL, ANON, { global: { headers: { authorization: auth } }, auth: { persistSession: false } });
    const { data: meRows } = await asUser.rpc("me");
    const me = Array.isArray(meRows) ? meRows[0] : meRows;
    if (!me || !me.company_id) return reply(401, { error: "Sign in first." });
    const { data: canImport } = await asUser.rpc("can", { p_action: "import" });
    if (canImport !== true) return reply(403, { error: "You don't have permission to import." });
    const { data: co } = await admin.from("companies").select("id, slug, drops_day_end, suspended_at").eq("id", me.company_id).single();
    if (!co || co.suspended_at) return reply(403, { error: "Not available." });
    const { data: row } = await admin.rpc("auto_import_row", { p_company: co.id });
    if (!row || !(row as Record<string, unknown>).config || !((row as Record<string, unknown>).config as Record<string, unknown>).base) {
      return reply(400, { error: "Automatic bookings aren't set up for this company yet." });
    }
    try {
      const s = await runCompany(co as { id: string; slug: string; drops_day_end?: string }, row as Record<string, unknown>);
      await record(co.id, true, "", s);
      return reply(200, { ok: true, summary: s });
    } catch (e) {
      await record(co.id, false, (e as Error).message, null);
      return reply(200, { ok: false, error: (e as Error).message });
    }
  } catch (err) {
    return reply(500, { error: (err as Error).message || String(err) });
  }
});
