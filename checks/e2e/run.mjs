// TAKEOFF OPS — browser tests: the real app (public/) in Chromium, phone-sized,
// against a pretend Supabase that behaves like the real one and records every
// call. Nothing touches the live database.
//
//   cd checks/e2e && npm install playwright@1 && node run.mjs
//   (Chromium: set CHROMIUM=/path/to/chrome if Playwright's own isn't installed)
//
// Every line prints PASS or FAIL; the run ends with the totals and exits 1 on
// any failure. Run it before merging a change to public/.
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.APP_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2" };
let passed = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) passed++; else failed++;
  console.log((cond ? "PASS " : "FAIL ") + name + (cond || detail === undefined ? "" : "   -> " + JSON.stringify(detail).slice(0, 300)));
};
const cspBlocked = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the app, served like Vercel does (/p/<token> → pt.html), with the same
// security headers as vercel.json, so a blocked script or photo shows up here ──
const SITE_HEADERS = Object.fromEntries(JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../vercel.json"), "utf8"))
  .headers.find((h) => h.source === "/(.*)").headers.map((h) => [h.key, h.value]));
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (/^\/p\/[A-Za-z0-9_-]+$/.test(p)) p = "/pt.html";
  if (p === "/") p = "/index.html";
  if (p === "/manifest.webmanifest") p = "/manifest-default.webmanifest";
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream", ...SITE_HEADERS });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = "http://127.0.0.1:" + server.address().port;

// ── dates as the app sees them (London, the DROPS day runs to 06:00) ──
const lon = (d) => Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).formatToParts(d).map((x) => [x.type, x.value]));
const L = lon(new Date());
const addDays = (key, n) => new Date(Date.parse(key + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
let TONIGHT = L.year + "-" + L.month + "-" + L.day; if (+L.hour < 6) TONIGHT = addDays(TONIGHT, -1);
const TOMORROW = addDays(TONIGHT, 1);
const iso = (key, hhmm) => new Date(key + "T" + hhmm + ":00Z").toISOString();

// ── a pretend Supabase with a tiny in-memory database ──
function makeDb(opts = {}) {
  const db = {
    me: { id: "s1", name: "RAKESH", role: "owner", company_id: "c1" },
    company: { id: "c1", name: "TAKEOFF", slug: "takeoff", yards: ["NB", "S"], drops_day_end: "06:00:00", brand: {}, time_zone: "Europe/London", pt_whatsapp: "447900000000", pt_method: opts.ptMethod || "photos", pt_method_ios: opts.ptMethodIos || opts.ptMethod || "photos", pt_copy_store: opts.ptStore || "supabase", overstay_rate: 0 },
    staff: [{ id: "s1", name: "RAKESH", role: "owner", active: true }, { id: "s2", name: "SUGU", role: "office", active: true }],
    sheets: [
      { id: "d0", company_id: "c1", kind: "drops", day: TONIGHT },
      { id: "d1", company_id: "c1", kind: "drops", day: TOMORROW },
      { id: "p0", company_id: "c1", kind: "picks", day: TONIGHT, short_until: addDays(TONIGHT, 3) },
    ],
    bookings: [
      { id: "b1", sheet_id: "d0", kind: "drops", ref: "R1", reg: "EK14JPV", num: 1, name: "SENIOR MISS", make: "FORD", flight: "U22312", return_at: iso(TONIGHT, "21:45"), phone: "07868 615571", note: "" },
      { id: "b2", sheet_id: "d0", kind: "drops", ref: "R2", reg: "CF75VLN", num: 2, name: "KHAIRA MS", make: "MG", flight: "U22368", return_at: iso(TONIGHT, "22:00"), phone: "7868615571 7868615571", note: "S/D" },
      { id: "b3", sheet_id: "d0", kind: "drops", ref: "R3", reg: "DV59ACF", num: 3, name: "GREBOSZ MX", flight: "U22580", return_at: iso(TONIGHT, "22:15"), note: "", sent_at: iso(TONIGHT, "20:56"), sent_by: "s2", yard: "T" },
      { id: "b4", sheet_id: "d1", kind: "drops", ref: "R4", reg: "DY16MYO", num: 2, name: "ATANASOV MX", flight: "W95393", return_at: iso(TOMORROW, "09:00"), note: "WRONG FLIGHT NUMBER" },
      { id: "b5", sheet_id: "d1", kind: "drops", ref: "R5", reg: "EN11KOO", num: 4, name: "JANKO MS", make: "BMW", flight: "W43301", return_at: iso(TOMORROW, "06:15"), note: "" },
      { id: "p1", sheet_id: "p0", kind: "picks", ref: "R4", reg: "DY16MYO", num: 1, name: "ATANASOV MX", drop_at: iso(TONIGHT, "14:00"), return_at: iso(addDays(TONIGHT, 1), "09:00"), intake: "", note: "" },
      { id: "p2", sheet_id: "p0", kind: "picks", ref: "P2", reg: "AF63WWH", num: 2, name: "MASON", drop_at: iso(TONIGHT, "15:00"), return_at: iso(addDays(TONIGHT, 2), "10:00"), intake: "", note: "" },
      { id: "p3", sheet_id: "p0", kind: "picks", ref: "P3", reg: "SF15LUA", num: 3, name: "KOLE", drop_at: iso(TONIGHT, "18:00"), return_at: iso(addDays(TONIGHT, 9), "10:00"), intake: "", note: "" },
      { id: "p4", sheet_id: "p0", kind: "picks", ref: "P4", reg: "HJ12PGK", num: 4, name: "FEJ", drop_at: iso(TONIGHT, "20:00"), return_at: iso(addDays(TONIGHT, 1), "20:00"), intake: "Collected", intake_at: iso(TONIGHT, "19:48"), intake_by: "s2", note: "" },
    ],
    ptLinks: [], uploads: [], calls: [], down: false,
  };
  db.bookings.forEach((b) => { b.company_id = "c1"; });
  return db;
}
const now = () => new Date().toISOString();
function rpc(db, fn, a) {
  const row = (id) => db.bookings.find((x) => x.id === id);
  // EARLY RETURN's night (part 75): tonight, or that day's DROPS sheet, made if missing.
  const earlySheet = (day) => {
    if (!day || day === TONIGHT) return "d0";
    let sh = db.sheets.find((x) => x.kind === "drops" && x.day === day);
    if (!sh) { sh = { id: "dx" + db.sheets.length, company_id: "c1", kind: "drops", day }; db.sheets.push(sh); }
    return sh.id;
  };
  switch (fn) {
    case "me": return db.me;
    case "set_capacity": {
      const yc = {}; for (const [k, v] of Object.entries(a.p_yards || {})) { if (!db.company.yards.includes(k)) throw new Error("Not a valid yard: " + k); if (+v) yc[k] = +v; }
      db.company.capacity = +a.p_total || null; db.company.yard_capacity = yc; return { capacity: db.company.capacity, yard_capacity: yc };
    }
    case "set_yard_colours": {
      const yc = {}; for (const [k, v] of Object.entries(a.p_colours || {})) { if (!db.company.yards.includes(k)) throw new Error("Not a valid yard: " + k); if (v) yc[k] = v.toUpperCase(); }
      db.company.yard_colours = yc; return { yard_colours: yc };
    }
    case "set_swipe_only": db.company.swipe_only = !!a.p_on; return !!a.p_on;
    case "admin_clients": return [{ id: "c1", name: "TAKEOFF", slug: "takeoff", yards: ["NB", "S"], brand: { colour: "#F59E0B", host: "takeoff-ops.vercel.app" }, staff: 14, has_owner: true, sheets_7d: 18, cars_7d: 2074, last_activity: now() }];
    case "admin_usage": return { db_bytes: 25709715, store_bytes: 0, store_files: 0, clients: [{ id: "c1", name: "TAKEOFF", cars_30d: 2074, sheets_30d: 18, pt_sets_30d: 134, pt_photos_30d: 4277, fr24_calls_30d: 209, fr24_calls_today: 46, timetable_runs_30d: 148, timetable_last_ok: now(), timetable_last_error: "", activity_30d: 5805 }] };
    case "owner_dashboard": (db.dashCalls = db.dashCalls || []).push(a.p_since); return db.dash || { added: [], paid: [], owed: [], removed: [], complaints: [], early: 0, changed: 0 };
    case "my_permissions": return db.perms || Object.fromEntries(["sent", "called", "clear", "yard", "summary", "log", "flights", "rtc", "picksinfo", "import", "staff", "settings", "note", "intake"].map((k) => [k, true]));
    case "tap_drop": {
      const b = row(a.p_booking), f = { sent: "sent", called: "called", clear: "cleared" }[a.p_action];
      b[f + "_at"] = a.p_on ? now() : null; b[f + "_by"] = a.p_on ? "s1" : null;
      if (a.p_action === "called") b.called_word = a.p_on ? a.p_word || "Called" : "";
      if (a.p_action === "clear") b.clear_word = a.p_on ? a.p_word || "Collected" : "";
      return b;
    }
    case "tap_pick": {
      const b = row(a.p_booking);
      if (a.p_key === "intake") { b.intake = a.p_value; b.intake_at = a.p_value ? now() : null; b.intake_by = a.p_value ? "s1" : null; }
      else if (a.p_key === "pt") { b.pt_at = a.p_value ? now() : null; b.pt_by = a.p_value ? "s1" : null; }
      else { b.pick_called = a.p_value; b.pick_called_at = a.p_value ? now() : null; }
      return b;
    }
    case "set_note": { const b = row(a.p_booking); b.note = a.p_note; return b; }
    case "download_my_company": return { format: "takeoff-ops-company-export", bookings: db.bookings };
    case "import_sheet": { const sh = db.sheets.find((x) => x.kind === a.p_kind && x.day === a.p_day); (db.imports = db.imports || []).push({ id: 70 + db.imports.length, kind: a.p_kind, day: a.p_day, at: now(), by: "RAKESH", added: a.p_rows.length, changed: 0, undone: false, latest: true }); return { sheet_id: sh ? sh.id : "p0", added: a.p_rows.length, updated: 0, early: 0, moved: 0, new_marked: 0, undo_id: 70 + db.imports.length - 1 }; }
    case "admin_save_client": (db.clientSaves = db.clientSaves || []).push(a.p); return { id: a.p.id, name: a.p.name, brand: a.p.brand };
    case "recent_imports": return db.imports || [];
    case "auto_import_status": return db.autoImport || { enabled: false };
    case "set_auto_import": { db.autoImport = Object.assign(db.autoImport || {}, { enabled: a.p_enabled }); return { enabled: a.p_enabled }; }
    case "pt_copy_report": (db.reports = db.reports || []).push(a); return null;
    case "undo_import": { const i = (db.imports || []).find((x) => x.id === a.p_id); if (i) i.undone = true; return { removed: 2, kept: 0, restored: 0, sheet_id: "p0", sheet_gone: false }; }
    case "pt_unsaved": return db.ptUnsaved || [];
    case "drops_missing": return (a.p_ids || []).map((id) => db.bookings.find((x) => x.id === id)).filter((b) => b && b.kind === "picks" && b.return_at)
      .map((b) => ({ b, d: db.sheets.find((s) => s.kind === "drops" && s.day === b.return_at.slice(0, 10)) }))
      .filter(({ b, d }) => d && !db.bookings.some((x) => x.sheet_id === d.id && x.reg === b.reg))
      .map(({ b, d }) => ({ id: b.id, reg: b.reg, name: b.name, return_at: b.return_at, day: d.day, sheet_id: d.id }));
    case "add_pick_to_drops": { const p = db.bookings.find((x) => x.id === a.p_booking), d = db.sheets.find((s) => s.kind === "drops" && s.day === p.return_at.slice(0, 10)); const n = { ...p, id: "dn" + db.bookings.length, sheet_id: d.id, kind: "drops" }; db.bookings.push(n); return n; }
    case "add_booking": { const n = { id: "new" + db.bookings.length, company_id: "c1", sheet_id: a.p_sheet, kind: db.sheets.find((x) => x.id === a.p_sheet).kind, ref: a.p.ref || "", reg: String(a.p.reg).toUpperCase(), name: a.p.name || "", num: 99, return_at: a.p.return_local ? new Date(a.p.return_local.replace(" ", "T") + ":00+01:00").toISOString() : null, note: a.p.note || "" };
      if (a.p.desk && n.kind === "picks") Object.assign(n, { pick_called: "New Booking", pick_called_at: now(), intake: a.p.taken_in ? "Collected" : "", intake_at: a.p.taken_in ? now() : null, yard: a.p.yard || "" });
      db.bookings.push(n); return n; }
    case "set_doc": { const b = row(a.p_booking); b.doc_path = a.p_path; b.doc_at = now(); return b; }
    case "set_exit_fee": db.company.exit_fee = a.p_fee; db.company.exit_free = a.p_free.map((x) => x.toUpperCase().replace(/[^A-Z0-9]/g, "")); return { exit_fee: a.p_fee, exit_free: db.company.exit_free };
    case "set_exit_paid": { const b = row(a.p_booking); Object.assign(b, { exit_method: a.p_method, exit_amount: a.p_method ? db.company.exit_fee : null, exit_at: a.p_method ? new Date().toISOString() : null, exit_by: a.p_method ? "s1" : null, exit_photo: a.p_photo || "" }); return b; }
    case "set_overstay_paid": { const b = row(a.p_booking); Object.assign(b, { charge_amount: a.p_amount, charge_method: a.p_method, charge_at: a.p_method ? new Date().toISOString() : null, charge_by: a.p_method ? "s1" : null }); return b; }
    case "set_overstay_agreed": { const b = row(a.p_booking); b.charge_agreed = a.p_amount; b.charge_reason = a.p_amount == null ? "" : (a.p_reason || ""); return b; }
    case "remove_booking": { const b = row(a.p_booking); Object.assign(b, { removed_at: new Date().toISOString(), removed_reason: a.p_reason, removed_by: "s1" }); return b; }
    case "restore_booking": { const b = db.bookings.find((x) => x.id === a.p_booking); Object.assign(b, { removed_at: null, removed_reason: "" }); return b; }
    case "set_return": { const b = row(a.p_booking); if (!b.orig_return_at) b.orig_return_at = b.return_at; b.return_at = new Date(a.p_return_local.replace(" ", "T") + ":00+01:00").toISOString();
      const to = db.sheets.find((x) => x.kind === "drops" && x.day === a.p_return_local.slice(0, 10) && x.day > (db.sheets.find((y) => y.id === b.sheet_id) || {}).day); if (to) b.sheet_id = to.id; return b; }
    case "set_reg": { const b = row(a.p_booking); b.reg = a.p_reg; return b; }
    case "set_yard": { const b = row(a.p_booking); b.yard = a.p_yard; return b; }
    case "set_flight": { const b = row(a.p_booking); b.flight = a.p_flight; return b; }
    case "set_pick_flight": { const b = row(a.p_booking); b.flight = a.p_flight; return b; }
    case "set_pick_return": { const b = row(a.p_booking); b.return_at = new Date(a.p_return_local.replace(" ", "T") + ":00+01:00").toISOString(); return b; }
    case "set_sched_time": { const b = row(a.p_booking); b.sched_time = a.p_time; return b; }
    case "early_return": { const b = row(a.p_booking); b.moved_from = b.sheet_id; b.sheet_id = earlySheet(a.p_day); b.early = true; b.early_at = now(); b.num = 105; return b; }
    case "early_return_from_picks": { const p = row(a.p_picks); const n = { ...p, id: "de" + db.bookings.length, sheet_id: earlySheet(a.p_day), kind: "drops", num: 106, early: true, early_at: now(), moved_from: "d1", intake: "", called_at: null, sent_at: null, cleared_at: null }; db.bookings.push(n); return n; }
    case "undo_early_return": { const b = row(a.p_booking); b.sheet_id = b.moved_from; b.moved_from = null; b.early = false; return b; }
    case "pt_link_save": {
      let l = db.ptLinks.find((x) => x.token === a.p_token);
      if (!l) db.ptLinks.push(l = { token: a.p_token, booking_id: a.p_booking, paths: [], at: now() });
      l.paths = [...new Set(l.paths.concat(a.p_paths))];
      return a.p_token;
    }
    case "pt_photos_for": {
      const me = row(a.p_booking);
      return db.ptLinks.filter((l) => { const b = row(l.booking_id); return b && (b.id === me.id || b.ref === me.ref); }).map((l) => ({ token: l.token, n: l.paths.length, at: l.at, by: "RAKESH" }));
    }
    case "set_pt_method": db.company.pt_method = a.p_method; return a.p_method;
    case "set_pt_method_ios": db.company.pt_method_ios = a.p_method; return a.p_method;
    default: return null;
  }
}
const R2 = "https://1b2139c185037dcd7e0328869b8b6fcf.r2.cloudflarestorage.com";
async function backend(ctx, db) {
  await ctx.route("**/*.supabase.co/**", async (route) => {
    const req = route.request(), u = new URL(req.url()), p = u.pathname;
    const reply = (status, body) => route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    if (p.startsWith("/realtime/")) return route.abort();
    if (p.startsWith("/auth/")) return reply(200, {});
    if (db.down) return route.fulfill({ status: 503, contentType: "text/plain", body: "upstream connect error" });
    if (p.startsWith("/rest/v1/rpc/")) {
      const fn = p.slice(13), args = JSON.parse(req.postData() || "{}");
      db.calls.push({ fn, args });
      return reply(200, rpc(db, fn, args));
    }
    if (p.startsWith("/storage/v1/object/sign/pt-photos/")) return reply(200, { signedURL: "/object/sign/pt-photos/" + p.slice(34) + "?token=t" });
    if (p.startsWith("/storage/v1/object/pt-photos/")) { db.uploads.push(p.slice(29)); (db.uploadMarks = db.uploadMarks || []).push(((req.postDataBuffer() || Buffer.alloc(0)).toString("latin1").match(/name="cacheControl"\r\n\r\n(\d+)/) || [])[1] || ""); return reply(200, { Key: "pt-photos/" + p.slice(29) }); }
    if (p.startsWith("/functions/v1/manage-staff")) {
      const a = JSON.parse(req.postData() || "{}"); (db.staffCalls = db.staffCalls || []).push(a);
      // Opening a client: from now on the phone is that client's owner.
      if (a.action === "client_open") { db.company = db.clientCompany; db.me = { ...db.me, company_id: db.company.id, name: "RAKESH (PARKING OPS)" }; return reply(200, { token_hash: "th", name: db.company.name }); }
      return reply(400, { error: "not in the test" });
    }
    if (p.startsWith("/functions/v1/takeoff-bookings")) {
      (db.autoRuns = db.autoRuns || []).push(JSON.parse(req.postData() || "{}"));
      return reply(200, { ok: true, summary: { days: [{ kind: "drops", day: TONIGHT, added: 2, updated: 1 }, { kind: "picks", day: TONIGHT, added: 3, updated: 0 }], drops_rows: 3, picks_rows: 3 } });
    }
    if (p.startsWith("/functions/v1/pt-r2")) {
      const a = JSON.parse(req.postData() || "{}");
      (db.r2Asks = db.r2Asks || []).push({ ...a, auth: req.headers()["authorization"] || "" });
      if (db.r2Down) return reply(503, { error: "Photo store not set up yet." });
      return reply(200, { urls: Object.fromEntries(a.names.map((n) => [n, `${R2}/takeoff-pt-photos/c1/${a.booking}/${a.token}/${n}?X-Amz-Signature=x`])) });
    }
    if (p.startsWith("/functions/v1/pt-photos")) {
      const l = db.ptLinks.find((x) => x.token === JSON.parse(req.postData()).token);
      return l ? reply(200, { reg: "DY16MYO", company: "TAKEOFF", by: "RAKESH", created_at: l.at, photos: l.paths.map((x, i) => ({ url: BASE + "/icons/icon-192.png", download: BASE + "/icons/icon-192.png", name: "DY16MYO-0" + (i + 1) + ".jpg" })) }) : reply(404, { error: "These photos have expired or the link isn't right." });
    }
    const q = Object.fromEntries(u.searchParams);
    if (p === "/rest/v1/companies") return reply(200, db.company);
    // The owner's last "download company data" (backup reminder): today, unless a test says otherwise.
    if (p === "/rest/v1/activity" && q.action === "eq.SETTINGS") return reply(200, db.lastDownload === null ? [] : [{ at: db.lastDownload || new Date().toISOString() }]);
    if (p === "/rest/v1/activity" && (q.booking_id || "").startsWith("in.(")) {
      const ids = q.booking_id.slice(4, -1).split(",").map((x) => x.replace(/"/g, ""));
      return reply(200, (db.activity || []).filter((a) => ids.includes(a.booking_id)).sort((x, y) => (x.at < y.at ? 1 : -1)));
    }
    // Summary → Activity: all activity, newest first.
    if (p === "/rest/v1/activity") return reply(200, (db.activity || []).slice().sort((x, y) => (x.at < y.at ? 1 : -1)));
    if (p === "/rest/v1/staff") return reply(200, db.staff);
    if (p === "/rest/v1/sheets") return reply(200, db.sheets);
    if (p === "/rest/v1/bookings") {
      let rows = db.bookings.filter((b) => !b.removed_at);
      if (q.sheet_id && q.sheet_id.startsWith("eq.")) rows = rows.filter((b) => b.sheet_id === q.sheet_id.slice(3));
      if (q.sheet_id && q.sheet_id.startsWith("neq.")) rows = rows.filter((b) => b.sheet_id !== q.sheet_id.slice(4));
      if (q.id && q.id.startsWith("eq.")) rows = rows.filter((b) => b.id === q.id.slice(3));
      if (q.id && q.id.startsWith("neq.")) rows = rows.filter((b) => b.id !== q.id.slice(4));
      if (q.ref && q.ref.startsWith("eq.")) rows = rows.filter((b) => b.ref === q.ref.slice(3));
      (db.bookingGets = db.bookingGets || []).push(q);
      if (q.updated_at && q.updated_at.startsWith("gte.")) { const t = q.updated_at.slice(4); rows = rows.filter((b) => (b.updated_at || "") >= t); }
      if (q.or) { const m = q.or.match(/%([^%]+)%/); const t = m ? m[1].toUpperCase() : ""; rows = rows.filter((b) => [b.reg, b.ref, b.phone, b.name].join(" ").toUpperCase().replace(/\s+/g, "").includes(t)); }
      if ((q.select || "").includes("sheets")) rows = rows.map((b) => ({ ...b, sheets: (({ day, kind }) => ({ day, kind }))(db.sheets.find((s) => s.id === b.sheet_id)) }));
      if (req.headers()["accept"] === "application/vnd.pgrst.object+json") return reply(200, rows[0] || null);
      return reply(200, rows);
    }
    return reply(200, []);
  });
  // Cloudflare R2: signed PUTs of the app's copies.
  await ctx.route(R2 + "/**", async (route) => {
    const req = route.request(), cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "PUT, GET" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: cors });
    if (req.method() === "PUT") { (db.r2Puts = db.r2Puts || []).push({ key: new URL(req.url()).pathname.slice(1), size: (req.postDataBuffer() || Buffer.alloc(0)).length, type: req.headers()["content-type"] }); return route.fulfill({ status: 200, headers: cors, body: "" }); }
    return route.fulfill({ status: 404, headers: cors, body: "" });
  });
  await ctx.route("https://wa.me/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "WhatsApp" }));
}
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const JWT = b64({ alg: "HS256" }) + "." + b64({ sub: "u1", role: "authenticated", exp: 4102444800 }) + ".sig";
async function phone(browser, db, { signedIn = true, ua, width = 390, noBitmap = false, still = "", pdfLabels = false, stuckBlob = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 844 }, userAgent: ua, permissions: ["camera"] });
  await backend(ctx, db);
  await ctx.addInitScript(([jwt, signedIn, noBitmap, still, pdfLabels, stuckBlob]) => {
    // Every label the PDF button shows, however quickly it changes.
    if (pdfLabels) {
      window.__pdfLabels = [];
      new MutationObserver(() => { const b = document.querySelector("[data-ptpdf]"); if (b && window.__pdfLabels[window.__pdfLabels.length - 1] !== b.textContent) window.__pdfLabels.push(b.textContent); })
        .observe(document, { childList: true, subtree: true, characterData: true });
    }
    // A pretend Android camera for real photos: "ok" (landscape, like the
    // video), "side" (handed back on its side) or "fail".
    if (still) {
      window.__stills = 0;
      window.ImageCapture = class {
        constructor(track) { this.track = track; }
        async getPhotoCapabilities() { return { fillLightMode: ["auto", "off", "flash"] }; }
        async takePhoto() {
          window.__stills++;
          if (still === "fail") throw new Error("camera busy");
          const side = still === "side", c = document.createElement("canvas"); c.width = side ? 600 : 800; c.height = side ? 800 : 600;
          const g = c.getContext("2d"); g.fillStyle = "#3a6"; g.fillRect(0, 0, c.width, c.height);
          return await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.9));
        }
      };
    }
    if (signedIn && !sessionStorage.getItem("seeded")) {
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("takeoff_link", "x".repeat(40));
      localStorage.setItem("sb-oioqjfrlwrjovnouhusp-auth-token", JSON.stringify({ access_token: jwt, refresh_token: "r", expires_at: 4102444800, expires_in: 3600, token_type: "bearer", user: { id: "u1" } }));
    }
    window.__shares = [];
    navigator.canShare = () => true;
    navigator.share = async (d) => { window.__shares.push({ n: (d.files || []).length, names: (d.files || []).map((f) => f.name), types: (d.files || []).map((f) => f.type), sizes: (d.files || []).map((f) => f.size), text: d.text || "" }); };
    try { navigator.clipboard.writeText = async () => {}; } catch (e) {}
    // Like an iPhone that won't decode a photo this way.
    if (noBitmap) window.createImageBitmap = () => Promise.reject(new Error("not supported"));
    // Like the Android phones where toBlob's answer never comes after the camera (10 Oct).
    if (stuckBlob) { window.__toBlobs = 0; HTMLCanvasElement.prototype.toBlob = function () { window.__toBlobs++; }; }
  }, [JWT, signedIn, noBitmap, still, pdfLabels, stuckBlob]);
  const page = await ctx.newPage();
  page.setDefaultTimeout(6000);
  page.__errors = [];
  page.on("pageerror", (e) => page.__errors.push(e.message));
  page.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) cspBlocked.push(m.text()); });
  page.__dialogs = [];
  page.on("dialog", (d) => { page.__dialogs.push(d.message()); d.accept(); });
  ctx.on("page", (p) => { if (p !== page) p.close().catch(() => {}); });
  return page;
}
const open = async (page) => { await page.goto(BASE + "/"); await page.waitForSelector("#main .row, #main .msg", { timeout: 8000 }); };
const text = (page, sel) => page.locator(sel).first().innerText().catch(() => "");
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const toast = (page) => page.evaluate(() => [...document.querySelectorAll(".toast")].map((t) => t.textContent).join(" | "));
// Open the DROPS or PICKS sheet: Operations' Drops | Picks in the bar, else the day picker.
const pickKind = async (page, kind) => {
  if (await page.isVisible("#kindBar")) await page.click('#kindBar [data-kind="' + kind + '"]');
  else if (await page.isVisible("#kindSeg")) await page.click('#kindSeg [data-kind="' + kind + '"]');
  else await page.selectOption("#sheetPick", kind === "picks" ? "p0" : "d0");
  await page.waitForFunction((k) => document.body.classList.contains("picks") === (k === "picks") && document.querySelector("#main .row"), kind);
};

// Each section stands alone: if one breaks part-way, it's reported and the rest still run.
async function scenario(fn) {
  try { await fn(); } catch (e) {
    const at = (String(e.stack || "").match(/run\.mjs:(\d+)/) || [])[1];
    check("section finished without crashing", false, String(e.message || e).split("\n")[0] + (at ? " (run.mjs line " + at + ")" : ""));
  }
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
// STRESS=1 node run.mjs: only the stress tests (big sheets on a slow phone, bad
// signal, big imports), at the bottom of this file. The normal run skips them.
// SHOTS=dir node run.mjs: only screenshots of the Operations look (SHOTS_THEME=stdplus for another), for previews.
if (process.env.SHOTS) { await shots(process.env.SHOTS); await browser.close(); server.close(); process.exit(0); }
if (process.env.STRESS) { await stressTests(); await browser.close(); server.close(); console.log("\n" + passed + " passed, " + failed + " failed"); process.exit(failed ? 1 : 0); }

// 1. first open, sign-in states
await scenario(async () => {
  const page = await phone(browser, makeDb(), { signedIn: false });
  await page.goto(BASE + "/"); await sleep(800);
  check("no personal link: shows the 'ask for your link' screen", await page.isVisible("#noLink"));
});

// 1b. the looks: Standard, Airport Parking Bay UI ("pro") and Cards ("cards"), each only by brand
const apbBrand = (theme) => ({ colour: "#1560BD", ink: "#FFFFFF", soft: "#E8F0FB", text: "#0E3F7E", short: "Parking Bay", theme, chrome: "#0E3F7E", mark: "P" });
const apbDb = (theme) => { const db = makeDb(); db.company = { ...db.company, name: "Airport Parking Bay", slug: "airport-parking-bay", yards: ["GS", "MY", "T"], brand: apbBrand(theme) }; return db; };
await scenario(async () => {
  const plain = await phone(browser, makeDb());
  await open(plain);
  check("Standard: no pro or cards look", await plain.evaluate(() => !document.documentElement.classList.contains("pro") && !document.documentElement.classList.contains("cards")));
  check("Standard: no cards, bottom bar or display setting", await plain.evaluate(() => getComputedStyle(document.querySelector(".row .rt")).display === "none" && getComputedStyle(document.getElementById("bnav")).display === "none" && /SENT/.test(document.querySelector('.row [data-act="sent"]').textContent)));

  const page = await phone(browser, apbDb("pro"), { width: 360 });
  await open(page); await sleep(300);
  const look = await page.evaluate(async () => {
    await document.fonts.ready;
    const reg = getComputedStyle(document.querySelector(".row .reg")), bar = getComputedStyle(document.querySelector(".top"));
    return { pro: document.documentElement.classList.contains("pro"), cards: document.documentElement.classList.contains("cards"), premium: document.documentElement.classList.contains("premium"), plate: reg.backgroundColor, bar: bar.backgroundColor, mark: document.querySelector(".tobrand").dataset.mark,
      font: document.fonts.check("700 16px 'Barlow Semi Condensed'"), theme: document.querySelector('meta[name="theme-color"]').content,
      rt: getComputedStyle(document.querySelector(".row .rt")).display, nav: getComputedStyle(document.getElementById("bnav")).display, word: document.querySelector('.row [data-act="sent"]').textContent };
  });
  check("Airport Parking Bay UI: switched on by the company's brand, and only that look", look.pro && !look.cards && !look.premium, look);
  check("Airport Parking Bay UI: regs are yellow number plates", look.plate === "rgb(247, 209, 23)", look.plate);
  check("Airport Parking Bay UI: the bar wears the brand's dark colour", look.bar === "rgb(14, 63, 126)" && look.theme === "#0E3F7E", look);
  check("Airport Parking Bay UI: the mark letter and the Barlow fonts load (CSP allows them)", look.mark === "P" && look.font, look);
  check("Airport Parking Bay UI: one line a car as before (no cards, no bottom bar)", look.rt === "none" && look.nav === "none" && /SENT/.test(look.word), look);
  check("Airport Parking Bay UI: no sideways scrolling on a 360 px phone", await noSideScroll(page));
  check("Airport Parking Bay UI: no errors", page.__errors.length === 0, page.__errors);
});
await scenario(async () => {
  const page = await phone(browser, apbDb("cards"), { width: 360 });
  await open(page); await sleep(300);
  const look = await page.evaluate(async () => {
    await document.fonts.ready;
    return { pro: document.documentElement.classList.contains("pro"), cards: document.documentElement.classList.contains("cards"), premium: document.documentElement.classList.contains("premium"), plate: getComputedStyle(document.querySelector(".row .reg")).backgroundColor,
      bar: getComputedStyle(document.querySelector(".bar")).backgroundColor, font: document.fonts.check("700 16px 'Barlow Semi Condensed'") };
  });
  check("Cards: switched on by the company's brand, and only that look", look.cards && !look.pro && !look.premium, look);
  check("Cards: yellow plates, the brand's dark bar, Barlow loads", look.plate === "rgb(255, 212, 59)" && look.bar === "rgb(14, 63, 126)" && look.font, look);
  check("Cards: no sideways scrolling on a 360 px phone", await noSideScroll(page));
  const card = await page.evaluate(() => ({ reg: document.querySelector('.row[data-id="b1"] .reg').textContent, name: document.querySelector('.row[data-id="b1"] .pin').textContent,
    noTimeCol: !document.querySelector('.row[data-id="b1"] .rt'),
    word: document.querySelector('.row[data-id="b3"] [data-act="sent"] .w').textContent, nav: getComputedStyle(document.getElementById("bnav")).display, tabs: document.getElementById("tabTodo").textContent }));
  check("Cards: the reg is the hero, the name reads as written, buttons have words, no time column", card.reg === "EK14JPV" && /Senior Miss/.test(card.name) && card.noTimeCol && card.word === "Sent", card);
  check("Cards: the tab reads 'N Waiting for action'", /^\d+ Waiting for action$/.test(card.tabs), card.tabs);
  check("Cards: the bottom bar is there", card.nav === "flex", card);
  check("Cards: no fold control (that is Premium only)", !(await page.isVisible("#tallyFold")));
  check("Cards: the buttons stay under the car (big cards)", await page.evaluate(() => { const row = document.querySelector('.row[data-id="b1"]'); return row.querySelector(".acts").getBoundingClientRect().top >= row.querySelector(".left").getBoundingClientRect().bottom - 1; }));
  await page.click('#bnav [data-bn="menuBtn"]'); await page.waitForSelector('[data-mode="dark"]');
  await page.click('[data-mode="dark"]'); await sleep(200);
  const dark = await page.evaluate(() => ({ on: document.documentElement.classList.contains("dark"), bg: getComputedStyle(document.body).backgroundColor, kept: localStorage.getItem("takeoff_mode") }));
  check("Cards: Dark in the menu turns the app dark and is remembered on the phone", dark.on && dark.bg === "rgb(10, 17, 29)" && dark.kept === "dark", dark);
  await page.click('[data-mode="light"]'); await sleep(200);
  check("Cards: Light turns it back", !(await page.evaluate(() => document.documentElement.classList.contains("dark"))));
  await page.keyboard.press("Escape"); await sleep(300);
  check("Cards: the shift header replaces the day dropdown", await page.isVisible("#shiftBtn") && !(await page.isVisible("#sheetPick")) && /CURRENT NIGHT SHIFT|TODAY/.test(await page.locator("#shiftBtn").innerText()));
  await page.click("#shiftBtn"); await page.waitForSelector("[data-pickshift]");
  check("Cards: Choose shift lists the sheets", /Choose shift/i.test(await page.locator("#shiftBody").innerText()) && (await page.locator("[data-pickshift]").count()) >= 2);
  const other = await page.locator("[data-pickshift]").nth(1).getAttribute("data-pickshift");
  await page.click('[data-pickshift="' + other + '"]'); await sleep(500);
  check("Cards: picking a shift opens it and closes the sheet", !(await page.isVisible("#shiftPick")) && (await page.locator("#sheetPick").inputValue()) === other);
  check("Cards: no errors", page.__errors.length === 0, page.__errors);
});

// Premium UI: the Cards look with a title bar, underline DROPS/PICKS, a white shift row and white tiles.
await scenario(async () => {
  const page = await phone(browser, apbDb("premium"), { width: 360 });
  await open(page); await sleep(300);
  const look = await page.evaluate(() => ({ cards: document.documentElement.classList.contains("cards"), premium: document.documentElement.classList.contains("premium"), board: document.documentElement.classList.contains("pboard"),
    pro: document.documentElement.classList.contains("pro"), head: document.getElementById("cHead").innerText, shiftBtn: !document.getElementById("shiftBtn").classList.contains("hidden"),
    tile: getComputedStyle(document.querySelector("#tally button")).backgroundColor, num: getComputedStyle(document.querySelector("#tally b")).color,
    underline: getComputedStyle(document.querySelector('#kindSeg [aria-pressed="true"]')).borderBottomColor, bar: getComputedStyle(document.querySelector(".bar")).backgroundColor, tabs: document.getElementById("tabTodo").textContent }));
  check("Premium: switched on by the brand, its own look only (not Cards, not Airport Parking Bay UI)", look.premium && !look.cards && !look.pro && !look.board, look);
  check("Premium: the title bar names the company, who is on and when it updated", /Parking Bay/.test(look.head) && /RAKESH · Owner/.test(look.head) && !/Operations/i.test(look.head) && /Updated \d\d:\d\d/.test(look.head), look.head);
  check("Premium: a navy title bar whatever the brand's text colour", look.bar === "rgb(14, 63, 126)", look.bar);
  check("Premium: white tiles with dark figures, brand-blue active tab underline", look.tile === "rgba(0, 0, 0, 0)" && look.num === "rgb(17, 24, 39)" && look.underline === "rgb(21, 96, 189)", look);
  check("Premium: the tab reads 'TO DO (N)' and the navy shift button is gone", /^TO DO \(\d+\)$/.test(look.tabs) && !look.shiftBtn, look);
  check("Premium: no sideways scrolling on a 360 px phone", await noSideScroll(page));
  check("Premium: the white shift row replaces the day dropdown", await page.isVisible("#cShift") && !(await page.isVisible("#sheetPick")) && /(Drops|Picks) · [\s\S]*change sheet/.test(await page.locator("#cShift").innerText()));
  await page.click("#cShift"); await page.waitForSelector("[data-pickshift]");
  check("Premium: the shift row opens Choose shift", /Choose shift/i.test(await page.locator("#shiftBody").innerText()));
  await page.click("[data-closeshift]"); await sleep(200);
  await page.click("#cHead"); await sleep(300);
  check("Premium: tapping the title opens the menu", await page.isVisible("#menu"));
  await page.keyboard.press("Escape"); await sleep(300);
  const lay = await page.evaluate(() => ({ tile: getComputedStyle(document.querySelector("#tally button")).alignItems, name: getComputedStyle(document.querySelector('.row[data-id="b1"] .pin')).textAlign }));
  check("Premium: the numbers sit centred and the name reads from the left", lay.tile === "center" && lay.name === "left", lay);
  const box = await page.evaluate(() => { const row = document.querySelector('.row[data-id="b1"]'), l = row.querySelector(".left").getBoundingClientRect(), a = row.querySelector(".acts").getBoundingClientRect();
    return { beside: a.top < l.bottom - 1, h: Math.round(row.getBoundingClientRect().height) }; });
  check("Premium: big cards, the buttons under the car (Premium Board has the dense rows)", !box.beside && box.h > 110, box);
  check("Premium: a Hide numbers control under the tiles", /Hide numbers/.test(await page.locator("#tallyFold").innerText()) && await page.isVisible("#tally"));
  await page.click("#tallyFold"); await sleep(300);
  const fold = await page.evaluate(() => ({ tally: getComputedStyle(document.getElementById("tally")).display, sum: document.getElementById("tallyFold").innerText, kept: localStorage.getItem("takeoff_tally_folded"), exp: document.getElementById("tallyFold").getAttribute("aria-expanded") }));
  check("Premium: folding hides the tiles and leaves a one-line summary", fold.tally === "none" && /2\s*no yard/i.test(fold.sum) && /Show/.test(fold.sum) && fold.kept === "1" && fold.exp === "false", fold);
  check("Premium: no sideways scrolling with the numbers folded", await noSideScroll(page));
  await page.reload(); await page.waitForSelector("#main .row"); await sleep(300);
  check("Premium: the fold is remembered on the phone", await page.evaluate(() => document.body.classList.contains("tfolded")));
  await page.click("#tallyFold"); await sleep(300);
  check("Premium: tapping the summary brings the numbers back", await page.isVisible("#tally") && await page.evaluate(() => localStorage.getItem("takeoff_tally_folded") === null));
  check("Premium: no errors", page.__errors.length === 0, page.__errors);
});

// Premium menu and summary: sections with icons, delete on its own, progress bar, activity by day with chips and search.
await scenario(async () => {
  const db = apbDb("premium");
  db.bookings.find((b) => b.id === "b1").cleared_at = now();
  db.activity = [
    { at: now(), staff_name: "SUGU", sheet_id: "d0", booking_id: "b3", reg: "DV59ACF", action: "SENT", value: "" },
    { at: now(), staff_name: "SUGU", sheet_id: "p0", booking_id: "p4", reg: "HJ12PGK", action: "INTAKE", value: "Collected" },
    { at: new Date(Date.now() - 2 * 864e5).toISOString(), staff_name: "RAKESH", action: "STAFF", value: "PIN changed for Jasnu" },
  ];
  const page = await phone(browser, db, { width: 360 });
  await open(page); await sleep(300);
  await page.click("#cHead"); await page.waitForSelector("#menu[open]");
  const menu = await page.evaluate(() => ({ labels: [...document.querySelectorAll("#menuBody > label")].map((l) => l.textContent), icons: document.querySelectorAll("#menuBody .menu-list .mi").length,
    lastList: [...document.querySelectorAll("#menuBody .menu-list")].pop().textContent, danger: !!document.querySelector("#menuBody .menu-danger [data-deletesheet]"),
    dangerInList: !!document.querySelector("#menuBody .menu-list [data-deletesheet]") }));
  check("Premium menu: sections Today, Office, This sheet, Display, You, with icons", ["TODAY", "OFFICE"].every((x) => menu.labels.includes(x)) && menu.labels.some((x) => /^THIS SHEET/.test(x)) && menu.labels.includes("DISPLAY") && menu.labels.includes("YOU") && menu.icons >= 8, menu);
  check("Premium menu: Delete this sheet sits alone at the bottom, not among the everyday buttons", menu.danger && !menu.dangerInList && /sign out/.test(menu.lastList), menu);
  await page.click('#menuBody [data-view="summary"]'); await page.waitForSelector(".actrow");
  const sum = await page.evaluate(() => ({ bar: document.querySelector(".stat.big .pbar i").style.width, pc: document.querySelector(".pbar-pc").textContent, days: [...document.querySelectorAll(".actday")].map((d) => d.textContent), rows: document.querySelectorAll(".actrow").length }));
  check("Premium summary: Cars back with a progress bar", sum.bar === "33%" && /33% done/.test(sum.pc), sum);
  check("Premium activity: grouped by day", sum.days.length === 2 && sum.rows === 3, sum);
  check("Premium activity: a coloured dot per line (Sent green, Intake Collected green, Staff grey)", await page.evaluate(() => [...document.querySelectorAll(".actrow .adot")].map((d) => d.className.replace("adot ", "")).join(",") === "d-s,d-s,d-x"));
  await page.click('[data-actf="picks"]'); await sleep(200);
  check("Premium activity: the Picks chip shows only picks work", await page.evaluate(() => document.querySelectorAll(".actrow").length === 1 && /HJ12PGK/.test(document.getElementById("actList").textContent)));
  await page.click('[data-actf="all"]'); await sleep(200);
  await page.fill("#actQ", "dv59"); await sleep(200);
  check("Premium activity: search finds by reg and keeps the keyboard up", await page.evaluate(() => document.querySelectorAll(".actrow").length === 1 && document.activeElement && document.activeElement.id === "actQ"));
  await page.click('[data-view="board"]').catch(() => {}); await page.click("#kindSeg [data-kind=picks]"); await page.waitForSelector('.row[data-id="p1"]');
  await page.click('#bnav [data-bn="logBtn"]'); await page.waitForSelector(".hbars");
  const hb = await page.evaluate(() => [...document.querySelectorAll(".hbar")].map((h) => ({ hh: h.querySelector(".hh").textContent, n: h.querySelector("b").textContent, top: h.classList.contains("top") })));
  check("Premium picks summary: cars in by hour as bars, the busiest hour marked", hb.length >= 1 && hb.some((h) => h.top && h.n === "1"), hb);
    check("Premium menu and summary: no sideways scrolling, no errors", (await noSideScroll(page)) && page.__errors.length === 0, page.__errors);
});

// Premium: Flights, Staff, Settings and Archive restyled.
await scenario(async () => {
  const db = apbDb("premium");
  Object.assign(db.bookings.find((b) => b.id === "b1"), { flight_status: "landed", est_time: "22:31" });
  const page = await phone(browser, db, { width: 360 });
  await open(page); await sleep(300);
  const go = async (v) => { await page.click("#cHead"); await page.waitForSelector("#menu[open]"); await page.click('#menuBody [data-view="' + v + '"]'); await sleep(500); };
  await go("flights");
  const fl = await page.evaluate(() => { const r = document.querySelector('.row.frow[data-id="b1"]'); return r && { h: Math.round(r.getBoundingClientRect().height), chip: r.querySelector(".l2a").textContent, chipBg: getComputedStyle(r.querySelector(".l2a")).backgroundColor, name: r.querySelector(".pin").textContent, time: r.querySelector(".l2b").textContent }; });
  check("Premium Flights: a tidy row per flight with a status chip and the times", fl && fl.h <= 80 && /Landed/i.test(fl.chip) && fl.chipBg !== "rgba(0, 0, 0, 0)" && /Senior Miss/.test(fl.name) && /^\d\d:\d\d/.test(fl.time.trim()), fl);
  await go("staff");
  const st = await page.evaluate(() => { const row = [...document.querySelectorAll(".staffbox .rowline")].find((r) => r.querySelector(".sbtns")); if (!row) return null;
    const name = row.querySelector(".grow").getBoundingClientRect(), btns = row.querySelector(".sbtns").getBoundingClientRect();
    return { below: btns.top >= name.bottom - 1, initial: getComputedStyle(row, "::before").content, oneRow: new Set([...row.querySelectorAll(".sbtns .btn")].map((b) => Math.round(b.getBoundingClientRect().top))).size === 1 }; });
  check("Premium Staff: the buttons sit under the name (never over it), on one row, with the person's initial", st && st.below && st.oneRow && /"S"/.test(st.initial), st);
  await go("settings");
  check("Premium Settings: From and Until side by side", await page.evaluate(() => { const p = document.querySelector(".pair"); if (!p) return false; const f = p.querySelectorAll(".field"); return f.length === 2 && Math.abs(f[0].getBoundingClientRect().top - f[1].getBoundingClientRect().top) < 2; }));
  check("Premium screens: no sideways scrolling, no errors", (await noSideScroll(page)) && page.__errors.length === 0, page.__errors);
});

// Premium looks: swipe right on a drop marks this person's step; pull down refreshes.
{
  const touch = (cdp, type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
  const drag = async (cdp, x0, y0, x1, y1, end = true) => {
    await touch(cdp, "touchStart", x0, y0);
    for (let i = 1; i <= 8; i++) { await touch(cdp, "touchMove", x0 + (x1 - x0) * i / 8, y0 + (y1 - y0) * i / 8); await sleep(16); }
    if (end) await touch(cdp, "touchEnd");
  };
  const swipeRow = async (page, cdp, id, dist = 130) => { const b = await page.locator('.row[data-id="' + id + '"]').boundingBox(); await drag(cdp, 25, b.y + b.height / 2, 25 + dist, b.y + b.height / 2); await sleep(400); };
  for (const [role, act] of [["bongo", "sent"], ["office", "called"], ["terminal", "clear"]]) {
    await scenario(async () => {
      const db = apbDb("board"); db.me = { ...db.me, role };
      const page = await phone(browser, db); await open(page); const cdp = await page.context().newCDPSession(page);
      await swipeRow(page, cdp, "b1");
      check("Swipe: a " + role + " swiping a drop right marks it " + act.toUpperCase(), db.calls.some((c) => c.fn === "tap_drop" && c.args.p_booking === "b1" && c.args.p_action === act && c.args.p_on === true), db.calls.filter((c) => c.fn === "tap_drop"));
      if (role === "bongo") {
        const n = db.calls.length;
        await swipeRow(page, cdp, "b3");   // already SENT
        check("Swipe: a car already marked is left alone (only marks, never unmarks)", !db.calls.slice(n).some((c) => c.fn === "tap_drop"), db.calls.slice(n));
        const n2 = db.calls.length;
        await swipeRow(page, cdp, "b2", 50);   // a short swipe does nothing
        check("Swipe: a short swipe does nothing", !db.calls.slice(n2).some((c) => c.fn === "tap_drop"));
        await page.click("#kindSeg [data-kind=picks]"); await page.waitForSelector('.row[data-id="p1"]');
        const n3 = db.calls.length;
        await swipeRow(page, cdp, "p1");
        check("Swipe: picks don't swipe", !db.calls.slice(n3).some((c) => /tap_/.test(c.fn)), db.calls.slice(n3));
      }
      check("Swipe (" + role + "): no errors", page.__errors.length === 0, page.__errors);
    });
  }
  // "Show buttons on drops" off works in every look that has swipe (it didn't on Standard with features).
  for (const theme of ["stdplus", "board", "premium"]) await scenario(async () => {
    const db = apbDb(theme); db.me = { ...db.me, role: "office" };
    const page = await phone(browser, db); await page.addInitScript(() => { localStorage.setItem("takeoff_swipe", "called"); localStorage.setItem("takeoff_swipe_only", "1"); }); await open(page);
    const r = await page.evaluate(() => ({ btns: document.querySelectorAll("#main .row [data-act]").length, steps: document.querySelectorAll("#main .row .acts.steps").length, rows: document.querySelectorAll("#main .row[data-id]").length }));
    check("Show buttons off (" + theme + "): no SENT / CALLED / CLEAR buttons on the drops, what's done instead", r.btns === 0 && r.steps === r.rows && r.rows > 0, r);
    await page.click('.row[data-id="b1"] .reg'); await page.waitForSelector("#panel[open]");
    check("Show buttons off (" + theme + "): tapping the reg still has the buttons", (await page.locator("#panel .pacts [data-act]").count()) === 3);
    check("Show buttons off (" + theme + "): no errors", page.__errors.length === 0, page.__errors);
  });
  // Swipe left: a second step, Off to start.
  await scenario(async () => {
    const db = apbDb("board"); db.me = { ...db.me, role: "office" };
    const page = await phone(browser, db); await open(page); const cdp = await page.context().newCDPSession(page);
    const b = await page.locator('.row[data-id="b1"]').boundingBox(), y = b.y + b.height / 2;
    await drag(cdp, 330, y, 200, y); await sleep(400);
    check("Swipe left: does nothing until someone picks a step for it", !db.calls.some((c) => c.fn === "tap_drop"));
    await page.click("#cHead"); await page.waitForSelector("#menu[open]");
    check("Swipe left: its own choice in the menu, Off to start", await page.evaluate(() => (document.querySelector("[data-swipeleft].on") || {}).textContent === "Off"));
    await page.click('[data-swipeleft="clear"]'); await sleep(200); await page.keyboard.press("Escape"); await sleep(300);
    await drag(cdp, 330, y, 200, y); await sleep(400);
    check("Swipe left: an office worker who picked Clear swipes left to mark CLEAR", db.calls.some((c) => c.fn === "tap_drop" && c.args.p_booking === "b1" && c.args.p_action === "clear"), db.calls.filter((c) => c.fn === "tap_drop"));
    const b2 = await page.locator('.row[data-id="b2"]').boundingBox();
    await drag(cdp, 25, b2.y + b2.height / 2, 155, b2.y + b2.height / 2); await sleep(400);
    check("Swipe left: swipe right still marks the office's own step (CALLED)", db.calls.some((c) => c.fn === "tap_drop" && c.args.p_booking === "b2" && c.args.p_action === "called"));
    check("Swipe left: no errors", page.__errors.length === 0, page.__errors);
  });
  // Standard with features gets the same working features.
  await scenario(async () => {
    const db = apbDb("stdplus"); db.me = { ...db.me, role: "bongo" };
    db.bookings.find((b) => b.id === "b1").cleared_at = now();
    const page = await phone(browser, db); await open(page); const cdp = await page.context().newCDPSession(page);
    await swipeRow(page, cdp, "b2");
    check("Standard with features: a bongo driver swipes a drop to SENT", db.calls.some((c) => c.fn === "tap_drop" && c.args.p_booking === "b2" && c.args.p_action === "sent"), db.calls.filter((c) => c.fn === "tap_drop"));
    const before = (db.bookingGets || []).length;
    const top = (await page.locator(".row").first().boundingBox()).y + 10;
    await drag(cdp, 200, top, 200, top + 180); await sleep(900);
    check("Standard with features: pull down to refresh", (db.bookingGets || []).length > before);
    await page.click("#tallyFold"); await sleep(300);
    check("Standard with features: Hide numbers folds the tiles to one line", await page.evaluate(() => getComputedStyle(document.getElementById("tally")).display === "none" && /Show/.test(document.getElementById("tallyFold").textContent)));
    await page.click('#bnav [data-bn="menuBtn"]'); await page.waitForSelector("#menu[open]");
    const m = await page.evaluate(() => ({ labels: [...document.querySelectorAll("#menuBody > label")].map((l) => l.textContent), swipe: (document.querySelector("[data-swipestep].on") || {}).textContent, danger: !!document.querySelector(".menu-danger [data-deletesheet]") }));
    check("Standard with features: the menu in sections, swipe choices, Delete on its own", m.labels.includes("TODAY") && m.labels.includes("SWIPE RIGHT ON DROPS") && m.swipe === "Sent" && m.danger, m);
    await page.click('#menuBody [data-view="summary"]'); await page.waitForSelector(".actbar");
    check("Standard with features: Summary has the progress bar and activity chips", await page.evaluate(() => !!document.querySelector(".stat.big .pbar i") && document.querySelectorAll(".actbar [data-actf]").length === 5));
    check("Standard with features (features): no errors", page.__errors.length === 0, page.__errors);
  });
  // Each person: Menu → Display → their swipe step, and buttons shown or hidden.
  await scenario(async () => {
    const db = apbDb("board"); db.me = { ...db.me, role: "owner" };
    const page = await phone(browser, db); await open(page); const cdp = await page.context().newCDPSession(page);
    await page.click("#cHead"); await page.waitForSelector("#menu[open]");
    const m = await page.evaluate(() => ({ steps: [...document.querySelectorAll("[data-swipestep]")].map((b) => b.textContent), on: (document.querySelector("[data-swipestep].on") || {}).textContent, btns: !!document.querySelector("[data-swipeonlyme]") }));
    check("Swipe choice: the menu offers Off / Sent / Called / Clear, an owner starts Off", m.steps.join("|") === "Off|Sent|Called|Clear" && m.on === "Off" && !m.btns, m);
    await page.click('[data-swipestep="clear"]'); await sleep(200);
    check("Swipe choice: once a step is picked, the buttons choice appears", await page.isVisible("[data-swipeonlyme]") && await page.evaluate(() => localStorage.getItem("takeoff_swipe") === "clear"));
    await page.keyboard.press("Escape"); await sleep(300);
    await swipeRow(page, cdp, "b1");
    check("Swipe choice: an owner who picked Clear swipes to mark CLEAR", db.calls.some((c) => c.fn === "tap_drop" && c.args.p_booking === "b1" && c.args.p_action === "clear"), db.calls.filter((c) => c.fn === "tap_drop"));
    check("Swipe choice: the buttons stay until this person hides them", (await page.locator('.row[data-id="b2"] [data-act="sent"]').count()) === 1);
    check("Swipe choice (owner): no errors", page.__errors.length === 0, page.__errors);
  });
  await scenario(async () => {
    const db = apbDb("board"); db.me = { ...db.me, role: "bongo" };
    const page = await phone(browser, db); await open(page); const cdp = await page.context().newCDPSession(page);
    await page.click("#cHead"); await page.waitForSelector("#menu[open]");
    check("Swipe choice: a bongo driver starts on Sent", await page.evaluate(() => (document.querySelector("[data-swipestep].on") || {}).textContent === "Sent"));
    check("Swipe choice: the buttons switch starts on (buttons shown)", await page.evaluate(() => document.querySelector("[data-swipeonlyme]").getAttribute("aria-checked") === "true"));
    await page.click("[data-swipeonlyme]"); await sleep(200);
    check("Swipe choice: tapping the switch turns the buttons off", await page.evaluate(() => document.querySelector("[data-swipeonlyme]").getAttribute("aria-checked") === "false"));
    await page.keyboard.press("Escape"); await sleep(300);
    const row = await page.evaluate(() => ({ btns: document.querySelectorAll('#main .row [data-act]').length, b3: (document.querySelector('.row[data-id="b3"] .acts.steps') || {}).textContent || "", b1: (document.querySelector('.row[data-id="b1"] .acts.steps') || {}).textContent || "" }));
    check("Swipe only (own choice): no buttons on drops, just what's done", row.btns === 0 && /Sent/i.test(row.b3) && /Swipe/.test(row.b1), row);
    await swipeRow(page, cdp, "b1");
    check("Swipe only: swiping still marks SENT", db.calls.some((c) => c.fn === "tap_drop" && c.args.p_booking === "b1" && c.args.p_action === "sent"));
    await page.click('.row[data-id="b2"] .reg'); await page.waitForSelector("#panel[open]");
    check("Swipe only: the car's panel has the buttons, to undo or fix", (await page.locator("#panel .pacts [data-act]").count()) === 3);
    await page.click('#panel .pacts [data-act="sent"]'); await sleep(400);
    check("Swipe only: a step tapped in the panel marks it and closes the panel", db.calls.some((c) => c.fn === "tap_drop" && c.args.p_booking === "b2" && c.args.p_action === "sent") && !(await page.isVisible("#panel")));
    await page.click("#kindSeg [data-kind=picks]"); await page.waitForSelector('.row[data-id="p1"]');
    check("Swipe only: picks keep their buttons", (await page.locator('.row[data-id="p1"] [data-pick]').count()) >= 3);
    check("Swipe only (bongo): no errors", page.__errors.length === 0, page.__errors);
  });
  await scenario(async () => {
    const db = apbDb("board"); db.me = { ...db.me, role: "owner" };
    const page = await phone(browser, db); await open(page); const cdp = await page.context().newCDPSession(page);
    await swipeRow(page, cdp, "b1");
    check("Swipe: owners and managers tap as before (no swipe)", !db.calls.some((c) => c.fn === "tap_drop"));
    const before = (db.bookingGets || []).length;
    const top = (await page.locator(".row").first().boundingBox()).y + 10;
    await drag(cdp, 200, top, 200, top + 180); await sleep(900);
    check("Pull down to refresh reloads the board", (db.bookingGets || []).length > before, { before, after: (db.bookingGets || []).length });
    check("Pull to refresh: no errors", page.__errors.length === 0, page.__errors);
  });
}

// Standard with features: the Standard look plus the bottom bar.
await scenario(async () => {
  const page = await phone(browser, apbDb("stdplus"), { width: 360 });
  await open(page); await sleep(300);
  const look = await page.evaluate(() => { const c = document.documentElement.classList;
    return { stdplus: c.contains("stdplus"), others: ["pro", "cards", "premium", "pboard"].filter((x) => c.contains(x)), nav: getComputedStyle(document.getElementById("bnav")).display,
      topIcons: ["logBtn", "flBtn", "psBtn"].map((id) => getComputedStyle(document.getElementById(id)).display), picker: getComputedStyle(document.getElementById("sheetPick")).display,
      oneLine: getComputedStyle(document.querySelector(".row")).display, head: !!document.querySelector("#cHead:not(.hidden)") }; });
  check("Standard with features: Standard's look, nothing else", look.stdplus && !look.others.length && !look.head && look.oneLine === "flex" && look.picker !== "none", look);
  check("Standard with features: the bottom bar is there, the top icons moved into it", look.nav === "flex" && look.topIcons.every((d) => d === "none"), look);
  check("Standard with features: no sideways scrolling on a 360 px phone", await noSideScroll(page));
  await page.click('#bnav [data-bn="logBtn"]'); await sleep(400);
  check("Standard with features: Summary in the bottom bar opens Summary", await page.evaluate(() => /Summary/i.test(document.getElementById("viewTitle").textContent)));
  await page.click("#bnBoard"); await sleep(300);
  check("Standard with features: Board brings the board back", await page.isVisible("#boardHead"));
  check("Standard with features: no errors", page.__errors.length === 0, page.__errors);
});
// Operations (theme ops): Standard with features in new chrome, the job rows exactly as Standard's.
await scenario(async () => {
  const rowLook = async (page, kind) => {
    if (kind === "picks") { await pickKind(page, "picks"); await sleep(200); }
    return page.evaluate(() => {
      const pick = (el, keys) => { const cs = getComputedStyle(el); return keys.map((k) => cs[k]).join("|"); };
      const rows = [...document.querySelectorAll("#main .row")].map((r) => [r.getBoundingClientRect().width, r.getBoundingClientRect().height,
        pick(r, ["backgroundColor", "fontSize", "padding", "borderBottom", "display"]), pick(r.querySelector(".reg"), ["fontSize", "fontWeight", "color"]),
        [...r.querySelectorAll(".acts button")].map((b) => { const q = b.getBoundingClientRect(); return [q.width, q.height, pick(b, ["backgroundColor", "color", "fontSize", "borderRadius", "border"])].join("/"); }).join(";")].join(" "));
      const sec = document.querySelector("#main .sec"), head = document.getElementById("colHead");
      return { rows, sec: sec ? pick(sec, ["backgroundColor", "fontSize", "padding"]) + sec.getBoundingClientRect().width : "", head: pick(head, ["backgroundColor", "fontSize"]) + head.getBoundingClientRect().width };
    });
  };
  const td = (theme) => { const db = makeDb(); db.company.brand = { colour: "#F9A01B", ink: "#1A1A1A", short: "TakeOff", theme }; return db; };
  const opsDb = td("ops"), std = await phone(browser, makeDb()), plus = await phone(browser, opsDb), feat = await phone(browser, td("stdplus"));
  await open(feat);
  check("Standard with features doesn't wear Operations", await feat.evaluate(() => !document.documentElement.classList.contains("ops") && getComputedStyle(document.body).backgroundColor === "rgb(255, 255, 255)"));
  await open(std); await open(plus); await sleep(300);
  for (const kind of ["drops", "picks"]) {
    const a = await rowLook(std, kind), b = await rowLook(plus, kind);
    check("Operations: " + kind + " rows exactly as Standard's (size, colours, buttons)", a.rows.length > 2 && JSON.stringify(a.rows) === JSON.stringify(b.rows), { std: a.rows[0], plus: b.rows[0] });
    check("Operations: " + kind + " group bar and column head as Standard's", a.sec === b.sec && a.head === b.head, { a, b });
  }
  const chrome = await plus.evaluate(() => ({ tab: getComputedStyle(document.querySelector("#boardHead .tabs button.on")).backgroundColor, bg: getComputedStyle(document.body).backgroundColor,
    who: getComputedStyle(document.getElementById("who"), "::after").content, tally: getComputedStyle(document.getElementById("tally")).borderRadius }));
  check("Operations: navy TO DO, grey page, numbers in a panel", chrome.tab === "rgb(24, 40, 59)" && chrome.bg === "rgb(245, 247, 250)" && chrome.tally === "6px", chrome);
  check("Operations: Standard itself keeps its own chrome", await std.evaluate(() => getComputedStyle(document.body).backgroundColor === "rgb(255, 255, 255)" && getComputedStyle(document.querySelector(".tabs button.on")).backgroundColor === "rgb(255, 255, 255)"));
  await plus.setViewportSize({ width: 1280, height: 900 }); await sleep(200);
  check("Operations: wide screen, board centred at 1120 px", await plus.evaluate(() => Math.round(document.getElementById("main").getBoundingClientRect().width) === 1120));
  check("Operations: no errors", plus.__errors.length === 0, plus.__errors);
  // As many jobs on the screen as Standard with features: the first row starts no lower.
  await plus.setViewportSize({ width: 390, height: 844 }); await sleep(150);
  const firstTop = (page) => page.evaluate(() => Math.round(document.querySelector("#main .row").getBoundingClientRect().top));
  for (const kind of ["picks", "drops"]) {
    for (const pg of [plus, feat]) await pickKind(pg, kind);
    await sleep(250);
    const [o, f] = [await firstTop(plus), await firstTop(feat)];
    check("Operations: " + kind + " jobs start no lower than in Standard with features", o <= f, { ops: o, stdplus: f }); console.log("   first row top (" + kind + ") ops " + o + " / stdplus " + f);
  }
  for (const pg of [plus, feat]) { await pg.click("#tallyFold"); }
  await sleep(250);
  { const [o, f] = [await firstTop(plus), await firstTop(feat)]; check("Operations: numbers folded, jobs still start no lower", o <= f, { ops: o, stdplus: f }); console.log("   first row top (folded) ops " + o + " / stdplus " + f); }
  for (const pg of [plus, feat]) { await pg.click("#tallyFold"); }
  check("Operations: Drops | Picks in the top bar, the open one pressed", await plus.evaluate(() => !document.getElementById("kindBar").classList.contains("hidden") && document.querySelector('#kindBar [data-kind="drops"]').getAttribute("aria-pressed") === "true"));
  await plus.click('#kindBar [data-kind="picks"]'); await plus.waitForSelector("body.picks"); await sleep(200);
  check("Operations: tapping Picks opens the PICKS sheet", await plus.evaluate(() => document.body.classList.contains("picks") && document.querySelector('#kindBar [data-kind="picks"]').getAttribute("aria-pressed") === "true"));
  check("Operations: the day picker lists only PICKS days, without the word", await plus.evaluate(() => { const o = [...document.querySelectorAll("#sheetPick option")]; return o.length === 1 && !/PICKS|DROPS/.test(o[0].textContent) && /today/.test(o[0].textContent); }), await plus.evaluate(() => [...document.querySelectorAll("#sheetPick option")].map((x) => x.textContent)));
  check("Operations: no sideways scrolling on a phone", await noSideScroll(plus));
  check("Standard with features: no Drops | Picks in the bar", await feat.evaluate(() => getComputedStyle(document.getElementById("kindBar")).display === "none"));
  // Hourly stats and Shift summary are pages in Operations.
  await pickKind(plus, "drops");
  await plus.click('#bnav [data-bn="psBtn"]'); await sleep(300);
  const stats = await plus.evaluate(() => ({ title: document.getElementById("viewTitle").textContent, panel: document.getElementById("panel").open, on: document.querySelector('#bnav [data-bn="psBtn"]').classList.contains("on"),
    strip: [...document.querySelectorAll("#main .ops-strip > div")].map((d) => d.innerText.replace(/\s+/g, " ")).join(" | "), cards: [...document.querySelectorAll("#main .ops-card header strong")].map((x) => x.textContent) }));
  check("Operations: Stats opens the Hourly stats page, marked in the bottom bar", stats.title === "Hourly stats" && !stats.panel && stats.on && stats.cards.includes("Returns by booked hour") && stats.cards.includes("Shift breakdown"), stats);
  check("Operations: Hourly stats numbers (drops)", stats.strip === "Due back 3 | Sent 1 | Collected 0 | Still to collect 3", stats.strip);
  await plus.click('#main [data-copy="stats"]'); await sleep(200);
  check("Operations: Copy stats copies", /Copied/.test(await toast(plus)), await toast(plus));
  await plus.click('#kindBar [data-kind="picks"]'); await plus.waitForSelector("body.picks"); await sleep(300);
  const pstats = await plus.evaluate(() => ({ view: document.getElementById("viewTitle").textContent, strip: [...document.querySelectorAll("#main .ops-strip > div")].map((d) => d.innerText.replace(/\s+/g, " ")).join(" | ") }));
  check("Operations: Picks from Hourly stats stays on Hourly stats", pstats.view === "Hourly stats" && pstats.strip === "Scheduled 4 | Completed 1 | Last 30 min 0 | Last 60 min 0", pstats);
  await plus.click('#bnav [data-bn="logBtn"]'); await sleep(300);
  const sum = await plus.evaluate(() => ({ title: document.getElementById("viewTitle").textContent, big: !!document.querySelector("#main .stat.big"), strip: [...document.querySelectorAll("#main .ops-strip span")].map((x) => x.textContent).join("|"), card: (document.querySelector("#main .ops-card header strong") || {}).textContent }));
  check("Operations: Shift summary page (picks): headline, numbers in a strip, cars in by hour", sum.title === "Shift summary" && sum.big && sum.strip === "Still to come|No shows|RTC" && sum.card === "Cars in by collection hour", sum);
  await feat.click('#bnav [data-bn="psBtn"]'); await sleep(300);
  check("Standard with features: Stats still opens the sheet from the bottom", await feat.evaluate(() => document.getElementById("panel").open && !document.querySelector("#main .ops-strip")));
  await feat.keyboard.press("Escape");
  check("Operations: no errors on the stats and summary pages", plus.__errors.length === 0, plus.__errors);
  await plus.click("#bnBoard"); await sleep(200);
  check("Operations: bottom bar and stdplus class on", await plus.evaluate(() => document.documentElement.classList.contains("stdplus") && document.documentElement.classList.contains("ops") && getComputedStyle(document.getElementById("bnav")).display === "flex"));
  // Menu, Flights, booking details, Staff & access and Settings: pages in the same design.
  await pickKind(plus, "drops");
  await plus.click('#bnav [data-bn="menuBtn"]'); await sleep(300);
  const menu = await plus.evaluate(() => { const m = document.getElementById("menu"), r = m.getBoundingClientRect(); return { open: m.open, title: m.querySelector("h2").textContent, groups: [...m.querySelectorAll("#menuBody > label")].map((x) => x.childNodes[0].textContent),
    items: [...m.querySelectorAll(".menu-list [data-view]")].map((x) => x.textContent), top: Math.round(r.top) === Math.round(document.querySelector(".bar").getBoundingClientRect().bottom), bottom: Math.round(r.bottom) === Math.round(document.getElementById("bnav").getBoundingClientRect().top),
    on: document.querySelector('#bnav [data-bn="menuBtn"]').classList.contains("on"), board: document.getElementById("bnBoard").classList.contains("on") }; });
  check("Operations: Menu is a page between the top and bottom bars, marked in the bottom bar", menu.open && menu.title === "Menu" && menu.top && menu.bottom && menu.on && !menu.board, menu);
  check("Operations: Menu sections in plain words", menu.groups.slice(0, 2).join("|") === "Operations|Office" && menu.items.includes("Operations board") && menu.items.includes("Hourly stats") && menu.items.includes("Staff & access"), menu);
  await plus.mouse.click(Math.round(390 * 0.3), 844 - 20); await sleep(300);
  const fl = await plus.evaluate(() => ({ menu: document.getElementById("menu").open, title: document.getElementById("viewTitle").textContent, on: document.querySelector('#bnav [data-bn="flBtn"]').classList.contains("on"),
    strip: [...document.querySelectorAll("#main .ops-strip > div")].map((d) => d.innerText.replace(/\s+/g, " ")).join(" | "), rows: document.querySelectorAll("#main .ops-fl").length, badge: (document.querySelector("#main .ops-fl .ops-badge") || {}).textContent, card: (document.querySelector("#main .ops-card header strong") || {}).textContent }));
  check("Operations: Flights in the bottom bar works from the Menu page and opens the Flights page", !fl.menu && fl.title === "Flights" && fl.on, fl);
  check("Operations: Flights page: numbers in a strip, each flight with its status", fl.strip === "Flights 3 | Landed 0 | Delayed 0 | Cancelled 0" && fl.rows === 3 && fl.badge === "Not checked yet" && fl.card === "Flight status", fl);
  await plus.click("#main .ops-fl [data-open]"); await sleep(300);
  const car = await plus.evaluate(() => { const p = document.getElementById("panel"), f = p.querySelector(".ops-foot2").getBoundingClientRect(); return { open: p.open, title: p.querySelector("h2").textContent, sub: p.querySelector(".sub").textContent,
    secs: [...p.querySelectorAll(".ops-psec")].map((x) => x.textContent), reg: (p.querySelector('label[for="regText"]') || {}).textContent, half: (() => { const a = p.querySelector("#flightText").getBoundingClientRect(), b = p.querySelector("#schedText").getBoundingClientRect(); return Math.round(a.top) === Math.round(b.top) && a.right < b.left; })(),
    foot: f.bottom <= p.getBoundingClientRect().bottom + 1 && f.top < innerHeight, save: p.querySelector("[data-savepanel]").textContent }; });
  check("Operations: tapping a flight opens Booking details, the reg under the title", car.open && car.title === "Booking details" && /^EK14JPV/.test(car.sub), car);
  check("Operations: Booking details in sections, flight number and landing side by side, Save always in view", car.secs.join("|") === "Customer & vehicle|Return & parking|Notes & status" && car.reg === "Registration" && car.half && car.foot && car.save === "Save changes", car);
  await plus.fill("#noteText", "ops note"); await plus.click("[data-savepanel]"); await sleep(300);
  check("Operations: Save changes saves the note and closes", !(await plus.evaluate(() => document.getElementById("panel").open)) && opsDb.calls.some((c) => c.fn === "set_note" && c.args.p_note === "ops note"));
  await plus.click('#bnav [data-bn="menuBtn"]'); await sleep(200); await plus.click('#menuBody [data-view="staff"]'); await sleep(300);
  const st = await plus.evaluate(() => ({ title: document.getElementById("viewTitle").textContent, head: document.querySelector("#main .ops-card header").innerText.replace(/\s+/g, " "), people: document.querySelectorAll("#main .ops-person").length,
    badges: [...document.querySelectorAll("#main .ops-person em")].map((x) => x.textContent).join("|"), you: document.querySelector("#main .ops-person small").textContent }));
  check("Operations: Staff & access page: team in one panel, each Active or Inactive", st.title === "Staff & access" && /^Team members \d+ people$/.test(st.head) && st.people >= 2 && /Active/.test(st.badges) && st.you === "Your account", st);
  await plus.click("#main .ops-dd summary"); await sleep(150);
  check("Operations: a person's Actions menu holds PIN and access, New link, Switch off", (await plus.locator("#main .ops-dd[open] button").allInnerTexts()).join("|") === "PIN and access|New link|Switch off", await plus.locator("#main .ops-dd[open] button").allInnerTexts());
  await plus.click("#main .ops-dd[open] [data-manage]"); await sleep(300);
  check("Operations: PIN and access from the Actions menu opens the person", await plus.evaluate(() => document.getElementById("panel").open && !document.querySelector("#main .ops-dd[open]")));
  await plus.keyboard.press("Escape"); await sleep(200);
  await plus.click("#main [data-addperson]"); await sleep(200);
  check("Operations: Add person opens the form", await plus.evaluate(() => !!document.querySelector("#main form#addStaff #newName") && document.activeElement.id === "newName"));
  await plus.click('#bnav [data-bn="menuBtn"]'); await sleep(200); await plus.click('#menuBody [data-view="settings"]'); await sleep(300);
  const se = await plus.evaluate(() => { const a = document.querySelector('[data-setting="enabled"]').getBoundingClientRect(), b = document.querySelector('[data-setting="live_every_min"]').getBoundingClientRect(), h = document.querySelector(".fchecks > strong");
    return { side: Math.round(a.top) === Math.round(b.top) && a.right < b.left, head: h.innerText.replace(/\s+/g, " "), unsaved: !!document.querySelector(".ops-unsaved") }; });
  check("Operations: Settings in panels, Flight checks two boxes a line, what it's set to by the title", se.side && se.head === "Flight checks Automatic checks on" && !se.unsaved, se);
  await plus.selectOption('[data-setting="live_every_min"]', "60"); await sleep(200);
  check("Operations: Settings says when there are unsaved changes", await plus.evaluate(() => /Unsaved changes/.test((document.querySelector(".ops-unsaved") || {}).textContent || "")));
  check("Operations: no errors on Menu, Flights, Booking details, Staff and Settings", plus.__errors.length === 0, plus.__errors);
  check("Operations: no sideways scrolling on Settings", await noSideScroll(plus));
  // Standard with features keeps its menu sheet, flight rows, car panel and staff buttons.
  await feat.click('#bnav [data-bn="menuBtn"]'); await sleep(250);
  const fm = await feat.evaluate(() => ({ title: document.querySelector("#menuBody h2").textContent, items: [...document.querySelectorAll("#menuBody .menu-list [data-view]")].map((x) => x.textContent), bottom: Math.round(document.getElementById("menu").getBoundingClientRect().bottom) === innerHeight }));
  check("Standard with features: menu still a sheet from the bottom, in its own words", fm.bottom && fm.title !== "Menu" && fm.items.includes("Board") && !fm.items.includes("Operations board"), fm);
  await feat.click('#menuBody [data-view="staff"]'); await sleep(300);
  check("Standard with features: Staff unchanged (buttons on each person)", await feat.evaluate(() => !document.querySelector("#main .ops-person") && !!document.querySelector("#main .staffbox .rowline [data-reset]")));
  await feat.click('#bnav [data-bn="menuBtn"]'); await sleep(200); await feat.click('#menuBody [data-view="flights"]'); await sleep(300);
  check("Standard with features: Flights unchanged", await feat.evaluate(() => !document.querySelector("#main .ops-fl") && document.querySelectorAll("#main .frow").length === 3));
  await feat.click("#main .frow [data-open]"); await sleep(300);
  check("Standard with features: car panel titled by the reg, no sections", await feat.evaluate(() => /^EK14JPV/.test(document.getElementById("panelTitle").textContent) && !document.querySelector("#panel .ops-psec") && !document.getElementById("panel").classList.contains("ops-car")));
  await feat.keyboard.press("Escape");
  await std.context().close(); await plus.context().close(); await feat.context().close();
});
await scenario(async () => {
  const page = await phone(browser, makeDb(), { width: 360 }); await open(page);
  check("Standard: still no bottom bar", await page.evaluate(() => getComputedStyle(document.getElementById("bnav")).display === "none"));
});

// Premium Board: Premium with two-line rows like the old board.
await scenario(async () => {
  const page = await phone(browser, apbDb("board"), { width: 360 });
  await open(page); await sleep(300);
  const look = await page.evaluate(() => { const c = document.documentElement.classList, row = document.querySelector('.row[data-id="b1"]');
    const l = row.querySelector(".left").getBoundingClientRect(), a = row.querySelector(".acts").getBoundingClientRect();
    return { premium: c.contains("premium"), board: c.contains("pboard"), cards: c.contains("cards"), pro: c.contains("pro"), head: !!document.querySelector("#cHead:not(.hidden)"),
      h: Math.round(row.getBoundingClientRect().height), beside: a.left >= l.right - 1, name: row.querySelector(".pin").textContent, l1: row.querySelector(".l1").textContent, l2: row.querySelector(".l2").textContent,
      flat: getComputedStyle(row).borderRadius === "0px" && getComputedStyle(row).marginLeft === "0px", caps: getComputedStyle(row.querySelector('[data-act="sent"]')).textTransform, sec: (document.querySelector(".sec") || {}).textContent || "" }; });
  check("Premium Board: Premium's look plus the board rows, nothing else", look.premium && look.board && !look.cards && !look.pro && look.head, look);
  check("Premium Board: two-line rows like the old board, buttons beside the car", look.beside && look.h <= 80, look);
  check("Premium Board: rows like the old board: number and name on line 1, car and flight on line 2", /SENIOR MISS/.test(look.name) && !/#1/.test(look.name) && /#1/.test(look.l1) && /U22312/.test(look.l2) && !/#1/.test(look.l2), look);
  check("Premium Board: flat full-width rows, buttons in capitals, sections like COMING UP 3", look.flat && look.caps === "uppercase" && /^COMING UP\s*\d+/.test(look.sec.trim()), look);
  check("Premium Board: no sideways scrolling on a 360 px phone", await noSideScroll(page));
  await page.click("#kindSeg [data-kind=picks]"); await page.waitForSelector('.row[data-id="p1"]'); await sleep(200);
  const pk = await page.evaluate(() => { const row = document.querySelector('.row[data-id="p1"]'); return { h: Math.round(row.getBoundingClientRect().height), name: row.querySelector(".pin").textContent, l1: row.querySelector(".l1").textContent, l2: row.querySelector(".l2").textContent, coll: row.querySelector('[data-pick="Collected"]').textContent }; });
  check("Premium Board: picks like Standard: names as imported, number on line 1, drop time on line 2, COLL", pk.h <= 64 && /ATANASOV/.test(pk.name) && /#1/.test(pk.l1) && /drop \d\d:\d\d/.test(pk.l2) && pk.coll === "COLL", pk);
  check("Premium Board: no errors", page.__errors.length === 0, page.__errors);
});

// 2. DROPS board
await scenario(async () => {
  const db = makeDb(), page = await phone(browser, db);
  await open(page);
  check("board opens on tonight's DROPS sheet", (await page.locator("#sheetPick option:checked").innerText()).includes("DROPS"));
  check("tonight's cars are listed", await page.locator(".row").count() === 3, await page.locator(".row").count());
  check("SENT shows the time and the first name of who pressed it", /SENT\s*\d\d:\d\d\s*SUGU/.test(await text(page, '.row[data-id="b3"] [data-act="sent"]')), await text(page, '.row[data-id="b3"] [data-act="sent"]'));
  await page.click('.row[data-id="b1"] [data-act="sent"]'); await sleep(400);
  check("tapping SENT reaches the server", db.calls.some((c) => c.fn === "tap_drop" && c.args.p_action === "sent" && c.args.p_booking === "b1"));
  check("tapping SENT marks the button with my name", /RAKESH/.test(await text(page, '.row[data-id="b1"] [data-act="sent"]')));
  await page.click('.row[data-id="b2"] [data-act="called"]'); await sleep(400);
  check("CALLED moves the car into NEXT IN QUEUE", /NEXT IN QUEUE/.test(await page.locator("#main").innerText()) && (await page.locator("#main").innerText()).indexOf("CF75VLN") < (await page.locator("#main").innerText()).indexOf("COMING UP"));
  await page.click('.row[data-id="b2"] [data-act="clear"]'); await sleep(400);
  check("CLEAR alone keeps the car in TO DO (a car is done when SENT and CLEAR)", await page.locator('.row[data-id="b2"]').count() === 1);
  await page.click('.row[data-id="b2"] [data-act="sent"]'); await sleep(400);
  check("SENT + CLEAR takes the car out of TO DO", !(await page.locator('.row[data-id="b2"]').count()));
  await page.click("#tabAll"); await sleep(200);
  check("ALL still shows the cleared car", await page.locator('.row[data-id="b2"]').count() === 1);
  check("no sideways scrolling on the board at phone width", await noSideScroll(page));
  check("no errors on the board", page.__errors.length === 0, page.__errors);
});

// 3. search
await scenario(async () => {
  const db = makeDb(), page = await phone(browser, db);
  await open(page);
  await page.fill("#q", "EK14"); await sleep(600);
  check("search finds a car on this sheet", await page.locator(".row").count() === 1 && /EK14JPV/.test(await page.locator("#main").innerText()));
  await page.fill("#q", "EN11KOO"); await sleep(900);
  check("search finds a car on another day", /ON OTHER DAYS/.test(await page.locator("#main").innerText()) && /EN11KOO/.test(await page.locator("#main").innerText()));
  await page.click(".otherhit"); await sleep(800);
  check("tapping the other-day result opens that sheet", (await page.locator("#sheetPick option:checked").innerText()).includes(TOMORROW.slice(8, 10).replace(/^0/, "")) && await page.locator('.row[data-id="b5"]').count() === 1);
  await page.fill("#q", "ZZ99NOPE"); await sleep(900);
  check("search for a car nowhere says so", /Not found on any sheet|Not on this sheet/.test(await page.locator("#main").innerText()));
});

// 4. car panel
await scenario(async () => {
  const db = makeDb(), page = await phone(browser, db);
  await open(page);
  await page.click('.row[data-id="b2"] .reg'); await sleep(300);
  check("tapping the reg opens the car's panel", await page.isVisible("#panel"));
  const tel = await page.getAttribute("#panelBody a.tel", "href").catch(() => "");
  check("Call uses the first number when a booking has it twice", tel === "tel:07868615571", tel);
  await page.fill("#noteText", "KEYS IN OFFICE"); await page.click("[data-savepanel]"); await sleep(500);
  check("saving a note reaches the server", db.calls.some((c) => c.fn === "set_note" && c.args.p_note === "KEYS IN OFFICE"));
  check("the note shows on the row", /KEYS IN OFFICE/.test(await text(page, '.row[data-id="b2"]')));
  await page.click('.row[data-id="b1"] .reg'); await sleep(300);
  await page.fill("#schedText", "1320"); await page.click("[data-savepanel]"); await sleep(500);
  check("scheduled landing is typed: '1320' saves as 13:20", db.calls.some((c) => c.fn === "set_sched_time" && c.args.p_time === "13:20"), db.calls.filter((c) => c.fn === "set_sched_time"));
  await page.click('.row[data-id="b1"] .reg'); await sleep(300);
  await page.fill("#schedText", "2575"); await page.click("[data-savepanel]"); await sleep(400);
  check("a time that isn't one is refused with a message", /13:20/.test(await toast(page)) && db.calls.filter((c) => c.fn === "set_sched_time").length === 1);
  await page.click("[data-close]").catch(() => {}); await sleep(200);
  await page.click('.row[data-id="b1"] .reg'); await sleep(300);
  check("no sideways scrolling in the car panel", await noSideScroll(page));
});

// 5. early return
await scenario(async () => {
  const db = makeDb(), page = await phone(browser, db);
  await open(page);
  await page.selectOption("#sheetPick", "d1"); await sleep(700);
  await page.click('.row[data-id="b4"] [data-act="called"]'); await sleep(1500);
  check("CALLED on tomorrow's car offers the early return and OK moves it", db.calls.some((c) => c.fn === "early_return"));
  check("the app follows the car to tonight's sheet", (await page.locator("#sheetPick").inputValue()) === "d0");
  check("the early car shows 'EARLY · booked …' on its own line", /EARLY · booked/.test(await text(page, '.row[data-id="b4"]')));
  check("the flight number still shows on the early car", /W95393/.test(await text(page, '.row[data-id="b4"]')));
  await page.click('.row[data-id="b4"] .reg'); await sleep(300);
  check("the panel offers Undo", await page.locator("[data-undoearly]").count() === 1);
  await page.click("[data-undoearly]"); await sleep(1200);
  check("Undo puts it back on its booked day", db.calls.some((c) => c.fn === "undo_early_return") && (await page.locator("#sheetPick").inputValue()) === "d1");
});

// 5b. early return from the PICKS car (part 74): no DROPS row for its booked day yet
await scenario(async () => {
  const db = makeDb(), page = await phone(browser, db);
  await open(page);
  await page.selectOption("#sheetPick", "p0"); await sleep(700);
  await page.click('.row[data-id="p1"] .reg'); await sleep(300);
  check("a PICKS car not taken in has no EARLY RETURN", await page.locator("[data-pearly]").count() === 0);
  await page.click("[data-close]").catch(() => {}); await sleep(200);
  await page.click('.row[data-id="p4"] .reg'); await sleep(300);
  check("a PICKS car taken in, booked back later, offers EARLY RETURN to tonight's DROPS", /EARLY RETURN · add to/.test(await page.locator("[data-pearly]").innerText().catch(() => "")));
  await page.click("[data-pearly]"); await sleep(1500);
  check("EARLY RETURN on PICKS calls early_return_from_picks", db.calls.some((c) => c.fn === "early_return_from_picks" && c.args.p_picks === "p4"));
  check("the app follows the car to tonight's DROPS sheet", (await page.locator("#sheetPick").inputValue()) === "d0");
  const de = db.bookings.find((b) => b.kind === "drops" && b.reg === "HJ12PGK");
  check("the new DROPS car shows 'EARLY · booked …'", !!de && /EARLY · booked/.test(await text(page, '.row[data-id="' + de.id + '"]')));
  db.perms = Object.fromEntries(["sent", "clear", "summary", "intake"].map((k) => [k, true]));
  await open(page);
  await page.selectOption("#sheetPick", "p0"); await sleep(700);
  await page.click('.row[data-id="p4"] .reg'); await sleep(300);
  check("without CALLED rights there is no EARLY RETURN on PICKS", await page.locator("[data-pearly]").count() === 0);
});

// 5c. EARLY RETURN on a night picked (part 75): booked back in 9 days, coming in 3
await scenario(async () => {
  const db = makeDb(); db.bookings.find((b) => b.id === "p3").intake = "Collected";
  const page = await phone(browser, db);
  await open(page);
  await page.selectOption("#sheetPick", "p0"); await sleep(700);
  await page.click('.row[data-id="p3"] .reg'); await sleep(300);
  const box = page.locator("#earlyDay");
  check("EARLY RETURN has a night picker starting tonight", (await box.inputValue()) === TONIGHT && (await box.getAttribute("min")) === TONIGHT);
  check("the picker stops the night before the booked day", (await box.getAttribute("max")) === addDays(TONIGHT, 8));
  const night = addDays(TONIGHT, 3), before = await page.locator("#earlyTo").innerText();
  await box.fill(night); await box.dispatchEvent("change"); await sleep(200);
  const after = await page.locator("#earlyTo").innerText();
  check("the button names the night picked", after !== before && after.includes(String(+night.slice(8))), [before, after]);
  await page.click("[data-pearly]"); await sleep(1500);
  check("the night picked goes to the server", db.calls.some((c) => c.fn === "early_return_from_picks" && c.args.p_picks === "p3" && c.args.p_day === night), db.calls.filter((c) => /early/.test(c.fn)));
  const sh = db.sheets.find((x) => x.kind === "drops" && x.day === night);
  check("the app follows the car to that night's DROPS sheet", !!sh && (await page.locator("#sheetPick").inputValue()) === sh.id);
  check("it shows there marked EARLY", /EARLY · booked/.test(await text(page, "#main")));
  check("the toast names the night", (await toast(page)).includes(after.replace("EARLY RETURN · add to ", "")), await toast(page));
  // DROPS car on a later sheet: the picker there too, tonight by default
  await page.selectOption("#sheetPick", "d1"); await sleep(700);
  await page.click('.row[data-id="b5"] .reg'); await sleep(300);
  check("a DROPS car on a later sheet offers the picker, up to the night before its sheet", (await page.locator("#earlyDay").getAttribute("max")) === TONIGHT && (await page.locator("[data-early]").count()) === 1);
  await page.click("[data-early]"); await sleep(1500);
  check("tonight from the DROPS car sends tonight's day", db.calls.some((c) => c.fn === "early_return" && c.args.p_booking === "b5" && c.args.p_day === TONIGHT));
});

// 6. PICKS board
await scenario(async () => {
  const db = makeDb(), page = await phone(browser, db);
  await open(page);
  await page.selectOption("#sheetPick", "p0"); await sleep(700);
  const tiles = await page.locator("#catTally").innerText();
  check("PICKS shows SHORT LEFT and LONG LEFT", /SHORT LEFT/.test(tiles) && /LONG LEFT/.test(tiles), tiles);
  check("SHORT LEFT counts only short cars still LEFT (2)", /SHORT LEFT\s*2/.test(tiles), tiles);
  check("LONG LEFT counts long cars still LEFT (1)", /LONG LEFT\s*1/.test(tiles), tiles);
  await page.click('.row[data-id="p2"] [data-pick="Collected"]'); await sleep(400);
  check("COLL reaches the server and shows my name", db.calls.some((c) => c.fn === "tap_pick" && c.args.p_value === "Collected") && /RAKESH/.test(await text(page, '.row[data-id="p2"] [data-pick="Collected"]')));
  check("COLL lowers SHORT LEFT to 1", /SHORT LEFT\s*1/.test(await page.locator("#catTally").innerText()));
  check("no sideways scrolling on PICKS", await noSideScroll(page));
});

// 7. PT three ways
// A phone that refuses createImageBitmap (like the iPhone did): copies still small.
async function ptNoBitmap() {
  const { db, page } = await ptRun("photos", 3, { noBitmap: true });
  await page.click("[data-ptreg]"); await sleep(700);
  await page.click("[data-ptshare]"); await sleep(2500);
  check("PT on a phone that refuses createImageBitmap: sharing works, copies made small (marked 3601)", (await page.evaluate(() => window.__shares.length)) >= 1 && (db.uploadMarks || []).length === 3 && db.uploadMarks.every((m) => m === "3601"), db.uploadMarks);
}
async function ptRun(method, shots, opts = {}) {
  const db = makeDb({ ptMethod: method, ptMethodIos: opts.ios, ptStore: opts.store }), page = await phone(browser, db, opts);
  await open(page);
  await page.selectOption("#sheetPick", "p0"); await sleep(700);
  await page.click('.row[data-id="p1"] [data-pt]');
  await page.waitForFunction(() => document.getElementById("camVideo") && document.getElementById("camVideo").videoWidth > 0, null, { timeout: 8000 });
  for (let i = 0; i < shots; i++) await page.click("[data-shutter]");
  await sleep(500); await page.click("[data-camdone]");
  // Each tap keeps the sharpest of a few frames, so Done waits for the last ones.
  await page.waitForFunction(() => !document.getElementById("camVideo"), null, { timeout: 15000 }).catch(() => {});
  await sleep(1500);
  return { db, page };
}
await scenario(async () => {
  const { db, page } = await ptRun("photos", 12);
  check("PT (photos): the camera took 12 photos", await page.locator(".ptthumbs img").count() === 12);
  check("PT (photos): no sideways scrolling on the PT screen", await noSideScroll(page));
  await sleep(1500);
  check("PT (photos): no copy is made while PT's photos are still to send", db.uploads.length === 0, db.uploads.length);
  await page.click("[data-ptreg]"); await sleep(700);
  await page.click("[data-ptshare]"); await sleep(500);
  await page.click("[data-ptshare]"); await sleep(800);
  const sh = await page.evaluate(() => window.__shares);
  check("PT (photos): photos go 10 then 2, as photos only (no text)", sh.length === 2 && sh[0].n === 10 && sh[1].n === 2 && !sh[0].text, sh);
  check("PT (photos): PT gets ticked", db.calls.some((c) => c.fn === "tap_pick" && c.args.p_key === "pt"));
  await sleep(1500);
  const nums = db.uploads.map((u) => +u.match(/(\d+)\.jpg$/)[1]).sort((a, b) => a - b);
  check("PT (photos): the app keeps 10 of the 12, first to last, saved as one set", db.uploads.length === 10 && nums[0] === 1 && nums[9] === 12 && db.ptLinks.length === 1 && db.ptLinks[0].paths.length === 10, { up: nums, links: db.ptLinks.map((l) => l.paths.length) });
  check("PT (photos): the copies are made small (marked 3600)", (db.uploadMarks || []).length === 10 && db.uploadMarks.every((m) => m === "3600"), db.uploadMarks);
  check("PT (photos): no errors", page.__errors.length === 0, page.__errors);
});
await scenario(ptNoBitmap);
// Copies in Cloudflare R2: every photo, small, after PT's photos are sent.
await scenario(async () => {
  const { db, page } = await ptRun("photos", 12, { store: "r2" });
  await sleep(1500);
  check("PT (R2): no copy is made while PT's photos are still to send", !(db.r2Puts || []).length && !(db.r2Asks || []).length && !db.uploads.length);
  await page.click("[data-ptreg]"); await sleep(700);
  await page.click("[data-ptshare]"); await sleep(500);
  await page.click("[data-ptshare]"); await sleep(3000);
  const puts = db.r2Puts || [], nums = puts.map((x) => +x.key.match(/(\d+)\.jpg$/)[1]).sort((a, b) => a - b);
  check("PT (R2): all 12 photos go to Cloudflare, none to Supabase's store", puts.length === 12 && nums.join() === "1,2,3,4,5,6,7,8,9,10,11,12" && db.uploads.length === 0, { puts: nums, sb: db.uploads.length });
  check("PT (R2): upload addresses asked for once for the car, signed in", (db.r2Asks || []).length === 1 && db.r2Asks[0].action === "upload" && db.r2Asks[0].booking === "p1" && db.r2Asks[0].names.length === 12 && /^Bearer /.test(db.r2Asks[0].auth), db.r2Asks);
  check("PT (R2): copies are JPEGs made smaller than PT's photos", puts.every((x) => x.type === "image/jpeg" && x.size > 0 && x.size < 400000), puts.map((x) => x.size));
  const l = db.ptLinks[0] || { paths: [] };
  check("PT (R2): saved as one set of 12, each marked r2:", db.ptLinks.length === 1 && l.paths.length === 12 && l.paths.every((x) => /^r2:c1\/p1\/[A-Za-z0-9_-]+\/\d\d\.jpg$/.test(x)), l.paths);
  check("PT (R2): the browser's security rules let the uploads through", !cspBlocked.length, cspBlocked);
  check("PT (R2): no errors", page.__errors.length === 0, page.__errors);
  // The car's panel lists the set.
  await page.click('.row[data-id="p1"] .reg'); await sleep(800);
  check("PT (R2): the car's panel shows the 12 photos", /12 photos/.test(await text(page, "#ptPhotos")), await text(page, "#ptPhotos"));
});
// The car's panel shows its history: who did what, and when.
await scenario(async () => {
  const db = makeDb();
  db.activity = [
    { at: iso(TONIGHT, "07:57"), action: "RETURN CHANGED", value: "was 28 Sep 17:00, now 02 Oct 17:00 (changed by hand)", staff_name: "OFFICE", booking_id: "b1" },
    { at: iso(TONIGHT, "07:58"), action: "NOTE", value: "<img src=x onerror=alert(1)>RTN DATE", staff_name: "SAM", booking_id: "b1" },
    { at: iso(TONIGHT, "06:00"), action: "YARD", value: "NB", staff_name: "WASIM", booking_id: "b2" },
  ];
  const page = await phone(browser, db);
  await open(page);
  await page.click('.row[data-id="b1"] .reg'); await sleep(800);
  const h = await text(page, "#carHist");
  check("car history: shows who did what, newest first", /HISTORY/.test(h) && /SAM · NOTE/.test(h) && /OFFICE · RETURN CHANGED/.test(h) && h.indexOf("SAM") < h.indexOf("OFFICE") && /changed by hand/.test(h), h);
  check("car history: only this car's entries", !/WASIM/.test(h));
  check("car history: notes are shown as text, never run", /<img src=x/.test(h) && page.__errors.length === 0, page.__errors);
});
// The PT checklist on the camera screen: shown, folds away, remembered.
await scenario(async () => {
  const db = makeDb({ ptMethod: "pdf" }), page = await phone(browser, db);
  await open(page);
  await page.selectOption("#sheetPick", "p0"); await sleep(700);
  await page.click('.row[data-id="p1"] [data-pt]');
  await page.waitForFunction(() => document.getElementById("camVideo") && document.getElementById("camVideo").videoWidth > 0, null, { timeout: 8000 });
  const tips = await text(page, "#camTips");
  check("camera: the PT checklist is shown", /PT checklist/.test(tips) && /Crouch to door height/.test(tips) && /Close-up of every mark/.test(tips), tips);
  await page.screenshot({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + "/cam-tips.png" : "/dev/null" }).catch(() => {});
  await page.click('[data-camtips="off"]'); await sleep(300);
  check("camera: ✕ folds the checklist to a small button", await page.locator("#camTips").count() === 0 && await page.locator('[data-camtips="on"]').count() === 1);
  await page.click("[data-shutter]"); await sleep(600);
  await page.click("[data-camdone]"); await sleep(1500);
  await page.click("[data-close]").catch(() => {}); await sleep(300);
  await page.click('.row[data-id="p1"] [data-pt]').catch(() => {}); await sleep(300);
  await page.click("[data-ptcam]").catch(() => {});
  await page.waitForFunction(() => document.getElementById("camVideo") && document.getElementById("camVideo").videoWidth > 0, null, { timeout: 8000 }).catch(() => {});
  check("camera: stays folded next time (remembered)", await page.locator("#camTips").count() === 0 && await page.locator('[data-camtips="on"]').count() === 1);
  await page.click('[data-camtips="on"]'); await sleep(300);
  check("camera: the button opens it again", await page.locator("#camTips").count() === 1);
  check("camera: no errors", page.__errors.length === 0, page.__errors);
});
// Android: real photos from the camera, with the sharpest-frame way to fall back on.
const ANDROID = "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";
await scenario(async () => {
  const { page } = await ptRun("photos", 3, { ua: ANDROID, still: "ok" });
  check("PT (Android): real photos are off (they crashed phones), each tap still kept", await page.evaluate(() => window.__stills) === 0 && await page.locator(".ptthumbs img").count() === 3);
  check("PT (Android): no errors", page.__errors.length === 0, page.__errors);
});
await scenario(async () => {
  const { page } = await ptRun("photos", 2, { ua: ANDROID, still: "side" });
  const dims = await page.evaluate(() => [...document.querySelectorAll(".ptthumbs img")].map((i) => [i.naturalWidth, i.naturalHeight]));
  check("PT (Android): photos come out the right way round", dims.length === 2 && dims.every(([w, h]) => w > h), dims);
});
await scenario(async () => {
  const { db, page } = await ptRun("photos", 4, { ua: ANDROID, still: "fail" });
  check("PT (Android): a camera that won't take photos falls back, every tap still kept", await page.locator(".ptthumbs img").count() === 4);
  check("PT (Android): the camera is never asked for a real photo", await page.evaluate(() => window.__stills) === 0, await page.evaluate(() => window.__stills));
});
// Separate ways: photos on Android, PDF on iPhones.
await scenario(async () => {
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  const { page } = await ptRun("photos", 2, { ios: "pdf", ua: IPHONE });
  await page.waitForSelector("[data-ptpdf]", { timeout: 8000 });
  check("PT (iPhone): uses the iPhone choice (PDF), not Android's (photos)", await page.locator("[data-ptpdf]").count() === 1 && await page.locator("[data-ptreg]").count() === 0);
});
await scenario(async () => {
  const { page } = await ptRun("photos", 2, { ios: "pdf" });
  await sleep(1500);
  check("PT (Android): uses the Android choice (photos)", await page.locator("[data-ptreg]").count() === 1 && await page.locator("[data-ptpdf]").count() === 0);
});
// The iPhone way (no createImageBitmap) with R2: sharing still works, copies still small.
await scenario(async () => {
  const { db, page } = await ptRun("photos", 3, { store: "r2", noBitmap: true });
  await page.click("[data-ptreg]"); await sleep(700);
  await page.click("[data-ptshare]"); await sleep(2500);
  const puts = db.r2Puts || [];
  check("PT (R2, iPhone-like): sharing works and 3 small copies go to Cloudflare", (await page.evaluate(() => window.__shares.length)) >= 1 && puts.length === 3 && puts.every((x) => x.size < 120000) && db.ptLinks.length === 1, puts);
  check("PT (R2, iPhone-like): PT ticked, no errors", db.calls.some((c) => c.fn === "tap_pick" && c.args.p_key === "pt") && page.__errors.length === 0, page.__errors);
});
// The switch reaches a phone that's already open (no reload): read again when PT starts.
await scenario(async () => {
  const db = makeDb(), page = await phone(browser, db);
  await open(page);
  await page.selectOption("#sheetPick", "p0"); await sleep(700);
  db.company.pt_copy_store = "r2";
  await page.evaluate(() => { const real = Date.now; Date.now = () => real() + 120000; });
  await page.click('.row[data-id="p1"] [data-pt]');
  await page.waitForFunction(() => document.getElementById("camVideo") && document.getElementById("camVideo").videoWidth > 0, null, { timeout: 8000 });
  for (let i = 0; i < 3; i++) await page.click("[data-shutter]");
  await sleep(500); await page.click("[data-camdone]"); await sleep(1500);
  await page.click("[data-ptreg]"); await sleep(700);
  await page.click("[data-ptshare]"); await sleep(2500);
  check("switching the copies to Cloudflare reaches an open phone without a reload", (db.r2Puts || []).length === 3 && db.uploads.length === 0, { r2: (db.r2Puts || []).length, sb: db.uploads.length });
});
// Staff screen: only the buttons the server would allow.
async function staffScreen(role) {
  const db = makeDb();
  db.me.role = role; db.me.id = "s2"; db.me.name = "SUGU";
  db.staff = [{ id: "s1", name: "RAKESH", role: "owner", active: true }, { id: "s2", name: "SUGU", role, active: true },
    { id: "s3", name: "MANNY", role: "manager", active: true }, { id: "s4", name: "BONGO BOB", role: "bongo", active: true }];
  const page = await phone(browser, db);
  await open(page);
  await page.click("#menuBtn"); await sleep(300);
  await page.click('#menuBody [data-view="staff"]'); await sleep(500);
  const btns = async (id) => page.locator(`[data-reset="${id}"], [data-onoff="${id}"]`).count();
  return { page, owner: await btns("s1"), manager: await btns("s3"), bongo: await btns("s4"), me: await btns("s2") };
}
await scenario(async () => {
  const o = await staffScreen("office");
  check("staff (office): can give a bongo a new link or switch them off", o.bongo === 2, o);
  check("staff (office): no New link / Switch off on the owner or a manager", o.owner === 0 && o.manager === 0, o);
  check("staff (office): not on their own name either", o.me === 0, o);
  check("staff screen: no errors, no sideways scrolling", o.page.__errors.length === 0 && await noSideScroll(o.page), o.page.__errors);
});
await scenario(async () => {
  const m = await staffScreen("manager");
  check("staff (manager): buttons on a bongo, not on the owner", m.bongo === 2 && m.owner === 0, m);
});
// "Tick PT without sending photos" is reported, so a car with no copy has a reason.
await scenario(async () => {
  const db = makeDb();
  const page = await phone(browser, db);
  await open(page);
  await page.selectOption("#sheetPick", "p0"); await sleep(700);
  await page.click('.row[data-id="p2"] [data-pt]');
  await page.waitForSelector("[data-camdone]", { timeout: 8000 }); await sleep(400);
  await page.click("[data-camdone]"); await page.waitForSelector("[data-ptmark]", { timeout: 5000 });
  await page.click("[data-ptmark]");
  await sleep(500);
  const ask = await text(page, "#panelBody");
  check("PT without photos: asks first (open camera, or a reason), not ticked yet", /No photos in the app/.test(ask) && await page.locator("[data-ptcamgo]").count() === 1 &&
    await page.locator("[data-ptwhy]").count() === 4 && !db.calls.some((c) => c.fn === "tap_pick" && c.args.p_booking === "p2" && c.args.p_key === "pt"), ask);
  await page.click('[data-ptwhy="Camera not working"]'); await sleep(800);
  const hasBtn = await page.locator("[data-ptmark]").count();
  check("PT ticked without photos: ticked, and the reason reported", db.calls.some((c) => c.fn === "tap_pick" && c.args.p_booking === "p2" && c.args.p_key === "pt") &&
    (db.reports || []).some((x) => x.p_booking === "p2" && /ticked without photos in the app: Camera not working/.test(x.p_detail)), { hasBtn, reports: db.reports, taps: db.calls.filter((c) => c.fn === "tap_pick").map((c) => c.args) });
});
// Photos taken in the app, then "Tick PT without sending": no question, the copy is still saved.
await scenario(async () => {
  const { db, page } = await ptRun("photos", 2);
  await page.click("[data-ptmark]"); await sleep(3000);
  check("PT tick without sending, photos taken: ticked, no reason asked", db.calls.some((c) => c.fn === "tap_pick" && c.args.p_booking === "p1" && c.args.p_key === "pt") && await page.locator("[data-ptwhy]").count() === 0);
  check("PT tick without sending, photos taken: the app still saves its copy", db.ptLinks.length === 1 && db.ptLinks[0].paths.length === 2, db.ptLinks.map((l) => l.paths.length));
});
// The office sees PT NOT SAVED on a car whose PT photos aren't in the app.
await scenario(async () => {
  const db = makeDb(); db.bookings.find((x) => x.id === "p1").pt_at = new Date(Date.now() - 3 * 3600000).toISOString(); db.ptUnsaved = ["p1"];
  const page = await phone(browser, db);
  await open(page);
  await page.selectOption("#sheetPick", "p0"); await sleep(1000);
  check("office: PT NOT SAVED shows on the car's row", /PT NOT SAVED/.test(await text(page, '.row[data-id="p1"]')) && !/PT NOT SAVED/.test(await text(page, '.row[data-id="p2"]')));
});
// Cloudflare's side down: PT itself is untouched, nothing crashes.
await scenario(async () => {
  const { db, page } = await ptRun("photos", 3, { store: "r2" });
  db.r2Down = true;
  await page.click("[data-ptreg]"); await sleep(700);
  await page.click("[data-ptshare]"); await sleep(2500);
  check("PT (R2 down): sharing and the PT tick still work", (await page.evaluate(() => window.__shares.length)) >= 1 && db.calls.some((c) => c.fn === "tap_pick" && c.args.p_key === "pt"));
  check("PT (R2 down): no copies saved, no errors", db.ptLinks.length === 0 && !(db.r2Puts || []).length && page.__errors.length === 0, page.__errors);
  await sleep(30000);   // three tries (5 s, then 15 s): the office is told it's late
  const rep = (db.reports || []).find((x) => x.p_booking === "p1");
  check("PT (R2 down): the phone reports it's still trying, and why", !!rep && /copy delayed, still trying: Photo store not set up yet/.test(rep.p_detail) && /Android|computer|iPhone/.test(rep.p_detail), db.reports);
  check("PT (R2 down): no 'copy failed' yet, it hasn't given up", !(db.reports || []).some((x) => /copy failed/.test(x.p_detail)), db.reports);
  // The connection comes back: it tries again at once and the set is saved.
  db.r2Down = false;
  await page.evaluate(() => window.dispatchEvent(new Event("online"))); await sleep(6000);
  check("PT (R2 down): connection back, photos saved without reopening the app", db.ptLinks.length === 1 && db.ptLinks[0].paths.length === 3, db.ptLinks.map((l) => l.paths.length));
});
await scenario(async () => {
  // Parking Ops: open a client's board, see Usage, and come back.
  const db = makeDb();
  db.clientCompany = db.company;
  db.company = { id: "c0", name: "Parking Ops", slug: "platform", yards: [], drops_day_end: "06:00:00", brand: {}, time_zone: "Europe/London" };
  db.me = { ...db.me, company_id: "c0" };
  const page = await phone(browser, db);
  await page.goto(BASE + "/"); await page.waitForSelector("[data-clientopen]", { timeout: 8000 });
  check("Parking Ops: no CONNECTING on the Clients page", (await page.textContent("#sync")) === "");
  check("Parking Ops: each client has Open board", await page.locator('[data-clientopen="c1"]').count() === 1);
  await page.click("[data-usage]"); await page.waitForSelector("table.usage", { timeout: 5000 });
  const use = await page.textContent("#panelBody");
  check("Parking Ops: Usage shows the database, PT photos, FR24 and AeroDataBox", /24\.5 MB of 8 GB/.test(use) && /134 \/ 4277/.test(use) && /46 · about 1,794 credits/.test(use) && /AeroDataBox now\s*working/.test(use), use.slice(0, 400));
  await page.click("#panelBody [data-close]");
  check("Parking Ops: each client card says which look it has", /Standard/.test(await text(page, ".client")));
  await page.click('[data-clientedit="c1"]'); await page.waitForSelector("#clLook");
  check("Parking Ops: the client editor offers the seven looks", (await page.locator("#clLook option").allInnerTexts()).join("|") === "Standard|Airport Parking Bay UI|Cards (light and dark)|Premium UI|Premium Board|Standard with features|Operations");
  await page.selectOption("#clLook", "premium"); await page.click("#clGo"); await sleep(400);
  check("Parking Ops: choosing Premium UI saves theme premium", (db.clientSaves || []).some((x) => x.id === "c1" && x.brand.theme === "premium"), db.clientSaves);
  await page.click('[data-clientedit="c1"]'); await page.waitForSelector("#clLook");
  await page.selectOption("#clLook", "board"); await page.click("#clGo"); await sleep(400);
  check("Parking Ops: choosing Premium Board saves theme board", (db.clientSaves || []).some((x) => x.id === "c1" && x.brand.theme === "board"), db.clientSaves);
  await page.click('[data-clientedit="c1"]'); await page.waitForSelector("#clLook");
  await page.selectOption("#clLook", "stdplus"); await page.click("#clGo"); await sleep(400);
  check("Parking Ops: choosing Standard with features saves theme stdplus", (db.clientSaves || []).some((x) => x.id === "c1" && x.brand.theme === "stdplus"), db.clientSaves);
  await page.click('[data-clientedit="c1"]'); await page.waitForSelector("#clLook");
  await page.selectOption("#clLook", "ops"); await page.click("#clGo"); await sleep(400);
  check("Parking Ops: choosing Operations saves theme ops", (db.clientSaves || []).some((x) => x.id === "c1" && x.brand.theme === "ops"), db.clientSaves);
  await page.click('[data-clientedit="c1"]'); await page.waitForSelector("#clLook");
  await page.selectOption("#clLook", "pro"); await page.click("#clGo"); await sleep(400);
  check("Parking Ops: choosing Airport Parking Bay UI saves theme pro", (db.clientSaves || []).some((x) => x.id === "c1" && x.brand.theme === "pro"), db.clientSaves);
  await page.click('[data-clientedit="c1"]'); await page.waitForSelector("#clPicksYard");
  check("Parking Ops: Location on PICKS is off until ticked", !(await page.isChecked("#clPicksYard")));
  await page.check("#clPicksYard"); await page.click("#clGo"); await sleep(400);
  check("Parking Ops: ticking Location on PICKS saves picks_yard on", db.clientSaves[db.clientSaves.length - 1].brand.picks_yard === true, db.clientSaves[db.clientSaves.length - 1]);
  await page.click('[data-clientedit="c1"]'); await page.waitForSelector("#clLook");
  await page.selectOption("#clLook", "cards"); await page.click("#clGo"); await sleep(400);
  check("Parking Ops: choosing Cards saves theme cards", (db.clientSaves || []).slice(-1)[0].brand.theme === "cards");
  await page.click('[data-clientedit="c1"]'); await page.waitForSelector("#clLook");
  await page.selectOption("#clLook", ""); await page.click("#clGo"); await sleep(400);
  check("Parking Ops: back to Standard saves no theme", (db.clientSaves || []).slice(-1)[0].brand.theme === "");
  await page.click('[data-clientopen="c1"]');
  await page.waitForSelector("#main .row", { timeout: 8000 });
  check("Parking Ops: Open board opens the client's board as their owner", (db.staffCalls || []).some((x) => x.action === "client_open" && x.company_id === "c1") && await page.locator('.row[data-id="b1"]').count() === 1);
  check("Parking Ops: the way back is in the top bar", await page.isVisible("#homeBtn"));
  db.company = { id: "c0", name: "Parking Ops", slug: "platform", yards: [], drops_day_end: "06:00:00", brand: {}, time_zone: "Europe/London" };
  db.me = { ...db.me, company_id: "c0", name: "RAKESH" };
  await page.click("#homeBtn");
  await page.waitForSelector("[data-clientopen]", { timeout: 8000 });
  check("Parking Ops: back on the Clients page, no way-back button left", !(await page.isVisible("#homeBtn")) && (await page.evaluate(() => localStorage.getItem("po_home"))) === null);
  check("Parking Ops: no errors", page.__errors.length === 0, page.__errors);
});
await scenario(async () => {
  const { db, page } = await ptRun("pdf", 8, { pdfLabels: true });
  await page.waitForSelector("[data-ptpdf]:not([disabled])", { timeout: 8000 });
  const labels = await page.evaluate(() => window.__pdfLabels);
  check("PT (PDF): while it's made, the button counts the photos (x of 8)", new Set(labels.filter((l) => /^Making the PDF… \d of 8$/.test(l))).size >= 3 && labels.every((l) => !/Making/.test(l) || /\d of 8$/.test(l)), labels);
  check("PT (PDF): only the PDF button is offered", await page.locator("[data-ptreg]").count() === 0);
  await page.click("[data-ptpdf]"); await sleep(800);
  const sh = await page.evaluate(() => window.__shares);
  check("PT (PDF): one share, one PDF named after the reg, reg as the message", sh.length === 1 && sh[0].n === 1 && sh[0].types[0] === "application/pdf" && /^DY16MYO-PT-8-photos\.pdf$/.test(sh[0].names[0]) && sh[0].text === "DY16MYO", sh);
  check("PT (PDF): PT gets ticked", db.calls.some((c) => c.fn === "tap_pick" && c.args.p_key === "pt"));
});
// Android's stuck toBlob: PT still finishes on its own, no switching apps needed.
await scenario(async () => {
  const { page } = await ptRun("pdf", 4, { stuckBlob: true });
  check("PT (toBlob never answers): Done still closes the camera with every photo", await page.locator("#camVideo").count() === 0 && await page.locator(".ptthumbs img").count() === 4, await page.locator(".ptthumbs img").count());
  await page.waitForSelector("[data-ptpdf]:not([disabled])", { timeout: 15000 }).catch(() => {});
  check("PT (toBlob never answers): the PDF is still made", await page.locator("[data-ptpdf]:not([disabled])").count() === 1);
  check("PT (toBlob never answers): it gave up waiting on toBlob once, then used the plain way", (await page.evaluate(() => window.__toBlobs)) === 1, await page.evaluate(() => window.__toBlobs));
  await page.click("[data-ptpdf]").catch(() => {}); await sleep(800);
  const sh = await page.evaluate(() => window.__shares);
  check("PT (toBlob never answers): one PDF of 4 photos shared", sh.length === 1 && /^DY16MYO-PT-4-photos\.pdf$/.test(sh[0].names[0]) && sh[0].sizes[0] > 4000, sh);
  check("PT (toBlob never answers): no errors", page.__errors.length === 0, page.__errors);
});
await scenario(async () => {
  const { db, page } = await ptRun("link", 5, { stuckBlob: true });
  await page.waitForSelector("[data-ptlink]", { timeout: 15000 }).catch(() => {});
  check("PT link (toBlob never answers): photos still upload and the link is saved", db.uploads.length === 5 && db.ptLinks.length === 1 && db.ptLinks[0].paths.length === 5, { up: db.uploads.length, links: db.ptLinks.length });
});
await scenario(async () => {
  const { db, page } = await ptRun("link", 5);
  await page.waitForSelector("[data-ptlink]", { timeout: 10000 });
  const href = await page.getAttribute("[data-ptlink]", "href");
  check("PT (link): photos uploaded and saved as one link", db.uploads.length === 5 && db.ptLinks.length === 1 && db.ptLinks[0].paths.length === 5);
  check("PT (link): WhatsApp opens on the PT number with the reg and the link", /^https:\/\/wa\.me\/447900000000\?text=DY16MYO.*%2Fp%2F[A-Za-z0-9_-]{24}/.test(href), href);
  await page.click("[data-ptlink]"); await sleep(700);
  check("PT (link): PT gets ticked", db.calls.some((c) => c.fn === "tap_pick" && c.args.p_key === "pt"));
  // PT's page from the link
  const token = db.ptLinks[0].token, viewer = await phone(browser, db, { signedIn: false });
  await viewer.goto(BASE + "/p/" + token); await viewer.waitForSelector(".grid a", { timeout: 8000 });
  check("PT's link page shows every photo", await viewer.locator(".grid a").count() === 5);
  await viewer.goto(BASE + "/p/NOPEnopeNOPEnopeNOPEnope"); await sleep(1500);
  check("a wrong link says so instead of a blank page", /expired|isn't right/.test(await viewer.locator("#grid").innerText()));
  // the car's panel lists the photos, on PICKS and on its DROPS row
  await page.click('.row[data-id="p1"] .reg'); await sleep(800);
  check("the car's panel lists its PT photos", /5 photos/.test(await page.locator("#ptPhotos").innerText()));
});

// 8. Settings
await scenario(async () => {
  const db = makeDb(), page = await phone(browser, db);
  await open(page);
  await page.click("#menuBtn"); await sleep(300);
  await page.click('#menuBody [data-view="settings"]'); await sleep(500);
  const opts = await page.locator('select[data-ptmethod=""] option').allInnerTexts();
  check("Settings offers the three PT ways", opts.length === 3 && /PDF/.test(opts.join()) && /link/.test(opts.join()), opts);
  check("Settings has a separate PT choice for iPhones", await page.locator('[data-ptmethod="ios"] option').count() === 3);
  await page.selectOption('select[data-ptmethod=""]', "pdf"); await sleep(500);
  check("choosing PDF saves it", db.company.pt_method === "pdf" && db.calls.some((c) => c.fn === "set_pt_method"));
  await page.selectOption('[data-ptmethod="ios"]', "link"); await sleep(500);
  check("the iPhone choice saves on its own", db.company.pt_method_ios === "link" && db.company.pt_method === "pdf" && db.calls.some((c) => c.fn === "set_pt_method_ios"));
  check("no sideways scrolling in Settings", await noSideScroll(page));
  check("Settings: capacity first, with a field per yard", /Car park capacity[\s\S]*not set/.test(await page.locator("#main .box").first().innerText()) && await page.locator("[data-capyard]").count() === 2);
  await page.fill("#capTotal", "40"); await page.fill('[data-capyard="NB"]', "20");
  await page.click("[data-savecap]"); await sleep(500);
  check("Settings: capacity saves in all and per yard", db.company.capacity === 40 && JSON.stringify(db.company.yard_capacity) === '{"NB":20}' && /Now: 40 cars/.test(await page.locator("#main .box").first().innerText()));
  if (process.env.SHOT_DIR) await page.screenshot({ path: process.env.SHOT_DIR + "/capacity-settings.png" });
  await page.fill("#capTotal", "-5"); await page.click("[data-savecap]"); await sleep(300);
  check("Settings: capacity refuses a negative number", db.company.capacity === 40);
  await page.fill("#capTotal", ""); await page.fill('[data-capyard="NB"]', ""); await page.click("[data-savecap]"); await sleep(500);
  check("Settings: clearing capacity switches it off", db.company.capacity === null && JSON.stringify(db.company.yard_capacity) === "{}");
});

// 9. Supabase down
await scenario(async () => {
  const db = makeDb(), page = await phone(browser, db);
  await open(page); await sleep(2500);   // the board is kept on the phone
  db.down = true;
  await page.reload(); await sleep(3000);
  check("server down: the app opens the last board instead of signing out", await page.isVisible("#app") && await page.locator(".row").count() === 3);
  check("server down: the top bar says OFFLINE", /OFFLINE/.test(await text(page, "#sync")));
  await page.click('.row[data-id="b1"] [data-act="sent"]'); await sleep(800);
  check("server down: a tap still shows and waits to be sent", /TO SEND/.test(await text(page, "#sync")) && /SENT/.test(await text(page, '.row[data-id="b1"] [data-act="sent"]')));
  db.down = false; await sleep(20000);
  check("server back: the waiting tap reaches the server", db.calls.some((c) => c.fn === "tap_drop" && c.args.p_booking === "b1"));
  check("server back: OFFLINE goes away", !/OFFLINE/.test(await text(page, "#sync")));
});

// 10. an unexpected error never kills the app
await scenario(async () => {
  const page = await phone(browser, makeDb());
  await open(page);
  await page.evaluate(() => setTimeout(() => { throw new Error("test boom"); }, 0)); await sleep(500);
  check("an unexpected error shows a short message", /didn't work/.test(await toast(page)));
  await page.click("#tabAll"); await sleep(200);
  check("…and the app keeps working afterwards", await page.locator(".row").count() === 3);
});

// 11. hostile booking data never runs as code (names, notes, regs come from outside)
await scenario(async () => {
  const db = makeDb(), bad = '<img src=x onerror="window.__xss=1">';
  db.bookings.push({ id: "bx", company_id: "c1", sheet_id: "d0", kind: "drops", ref: "RX" + bad, reg: "XS55" + bad, num: 9, name: "EVIL" + bad, make: bad, flight: "U21234", return_at: iso(TONIGHT, "23:00"), phone: bad, note: "!" + bad });
  db.bookings.push({ id: "px", company_id: "c1", sheet_id: "p0", kind: "picks", ref: "PX", reg: "XS66" + bad, num: 9, name: "EVIL" + bad, drop_at: iso(TONIGHT, "21:00"), return_at: iso(addDays(TONIGHT, 1), "10:00"), intake: "", note: bad });
  db.staff.push({ id: "sx", name: "STAFF" + bad, role: "office", active: true });
  db.bookings.find((b) => b.id === "b1").sent_by = "sx"; db.bookings.find((b) => b.id === "b1").sent_at = iso(TONIGHT, "20:00");
  const page = await phone(browser, db);
  await open(page);
  await page.click('.row[data-id="bx"] .reg'); await sleep(400); await page.click("[data-close]");
  await page.fill("#q", "EVIL"); await sleep(900); await page.fill("#q", "");
  await page.selectOption("#sheetPick", "p0"); await sleep(700);
  await page.click('.row[data-id="px"] .l2'); await sleep(400);
  check("hostile names/notes/regs are shown as text, never run as code", await page.evaluate(() => window.__xss === undefined) && /EVIL/.test(await page.locator("#main").innerText()));
});

// 12. the DROPS car panel: meet date shown, no hint text, a mouse drag doesn't close it
await scenario(async () => {
  const db = makeDb();
  db.bookings.find((b) => b.id === "b5").drop_at = iso(addDays(TONIGHT, -5), "07:30");
  const page = await phone(browser, db, { width: 1280 });
  await open(page);
  await page.selectOption("#sheetPick", "d1"); await sleep(700);
  await page.click('.row[data-id="b5"] .reg'); await sleep(400);
  const body = await page.locator("#panelBody").innerText();
  check("DROPS panel shows the meet date and time", /MEET\n.*\d+ \w+ \d\d:\d\d\nBACK/.test(body));
  check("DROPS panel has no \"use this when they ring\" text", !/ring/i.test(body) && await page.locator("[data-early]").count() === 1);
  await page.locator("#noteText").scrollIntoViewIfNeeded();
  const box = await page.locator("#noteText").boundingBox();
  await page.mouse.move(box.x + 10, box.y + 10); await page.mouse.down();
  await page.mouse.move(5, box.y + 10, { steps: 5 }); await page.mouse.up(); await sleep(200);
  check("selecting text and letting go outside keeps the panel open", await page.evaluate(() => document.getElementById("panel").open));
  await page.mouse.click(5, 5); await sleep(200);
  check("a click outside still closes it", await page.evaluate(() => !document.getElementById("panel").open));
});

// 13. DROPS rows tag SAME DAY / NEXT DAY from the meet date
await scenario(async () => {
  const db = makeDb(), b = (id) => db.bookings.find((x) => x.id === id);
  b("b1").drop_at = iso(TONIGHT, "05:30"); b("b2").drop_at = iso(addDays(TONIGHT, -1), "09:00"); b("b3").drop_at = iso(addDays(TONIGHT, -4), "09:00");
  const page = await phone(browser, db);
  await open(page);
  const tag = (id) => page.locator('.row[data-id="' + id + '"] .cat').allInnerTexts().then((t) => t.join(""));
  check("DROPS: met today shows SAME", /SAME/.test(await tag("b1")));
  check("DROPS: met yesterday shows NEXT", /NEXT/.test(await tag("b2")));
  check("DROPS: met earlier shows no day tag", (await tag("b3")) === "");
});

// 14. return changed to a later day: WAS tag, charge from the first date; overstay block label
await scenario(async () => {
  const db = makeDb(), b = (id) => db.bookings.find((x) => x.id === id);
  db.company.overstay_rate = 30;
  b("b1").orig_return_at = iso(addDays(TONIGHT, -3), "23:00");
  Object.assign(b("b2"), { called_word: "Overstay", called_at: iso(TONIGHT, "18:28"), overstay: true });
  const page = await phone(browser, db);
  await open(page);
  await page.waitForSelector('.row[data-id="b1"] .reg', { timeout: 8000 }).catch(() => {});
  const row1 = await page.locator('.row[data-id="b1"]').innerText();
  check("changed return shows WAS and the day first booked", new RegExp("WAS " + String(+addDays(TONIGHT, -3).slice(8, 10)).padStart(2, "0")).test(row1));
  check("changed return is charged from the first date", /£\d+ DUE/.test(row1), row1);
  check("marked OVERSTAY today: the block says staying longer", /staying longer/i.test(await page.locator("#main").innerText()) && !/earlier days/i.test(await page.locator("#main").innerText()));
  await page.click('.row[data-id="b1"] .reg'); await sleep(400);
  check("the car panel shows the first booked return", /BACK\n.*was /.test(await page.locator("#panelBody").innerText()));
});

// 15. a booking with no reg: the reg is typed in the car's panel
await scenario(async () => {
  const db = makeDb();
  db.bookings.find((x) => x.id === "p1").reg = "";
  const page = await phone(browser, db);
  await open(page);
  await page.selectOption("#sheetPick", "p0"); await sleep(700);
  check("a car with no reg says NO REG", /NO REG/.test(await text(page, '.row[data-id="p1"] .reg')));
  await page.click('.row[data-id="p1"] .reg'); await sleep(400);
  await page.fill("#regText", "ab12  cde"); await page.click("[data-savepanel]"); await sleep(600);
  check("the typed reg reaches the server, tidied", db.calls.some((c) => c.fn === "set_reg" && c.args.p_reg === "AB12 CDE"));
  check("the row shows the new reg", /AB12 CDE/.test(await text(page, '.row[data-id="p1"] .reg')));
  await page.click('.row[data-id="p1"] .reg'); await sleep(400);
  await page.fill("#regText", "AB12-CDE"); await page.click("[data-savepanel]"); await sleep(300);
  check("a reg with odd characters is refused with a message", /letters and numbers/.test(await toast(page)) && !db.calls.some((c) => c.fn === "set_reg" && c.args.p_reg === "AB12-CDE"));
});

// 16. the owner is reminded weekly to keep their own copy of the data
await scenario(async () => {
  const db = makeDb(); db.lastDownload = new Date(Date.now() - 9 * 864e5).toISOString();
  const page = await phone(browser, db);
  await open(page); await sleep(500);
  check("backup reminder: shows when the last download was 9 days ago", /last downloaded 9 days ago/.test(await text(page, ".nudge")));
  await page.click(".nudge [data-backup]"); await sleep(500);
  check("backup reminder: Download now fetches the data and the reminder goes", db.calls.some((c) => c.fn === "download_my_company") && await page.locator(".nudge").count() === 0);
  const db2 = makeDb(); db2.me.role = "office"; db2.lastDownload = null;
  const page2 = await phone(browser, db2);
  await open(page2); await sleep(500);
  check("backup reminder: only the owner sees it", await page2.locator(".nudge").count() === 0);
});

// 17. a PICKS car added by a re-import shows NEW BOOKING
await scenario(async () => {
  const db = makeDb();
  Object.assign(db.bookings.find((x) => x.id === "p2"), { pick_called: "New Booking", pick_called_at: iso(TONIGHT, "16:05") });
  const page = await phone(browser, db);
  await open(page);
  await page.selectOption("#sheetPick", "p0"); await sleep(700);
  const tag = page.locator('.row[data-id="p2"] .tag.nb');
  check("re-imported PICKS car: NEW BOOKING tag on the row", await tag.count() === 1 && /NEW BOOKING/.test(await tag.innerText()));
  check("other PICKS cars have no NEW BOOKING tag", await page.locator('.row[data-id="p1"] .tag.nb').count() === 0);
});

// 18. import: an Excel file with real Excel date cells, read, previewed and sent
await scenario(async () => {
  const db = makeDb();
  const page = await phone(browser, db, { width: 1000 });
  await open(page);
  // Build the file in the browser with the app's own spreadsheet library.
  const b64 = await page.evaluate(async (day) => {
    await new Promise((ok, no) => { const s = document.createElement("script"); s.src = "/vendor/xlsx-0.18.5.full.min.js"; s.onload = ok; s.onerror = no; document.head.appendChild(s); });
    const [y, m, d] = day.split("-").map(Number);
    const serial = (dd, h, mi) => (Date.UTC(y, m - 1, dd, h, mi) - Date.UTC(1899, 11, 30)) / 864e5;
    const ws = XLSX.utils.aoa_to_sheet([["Ref", "Name", "Vehicle", "Booking From", "Booking To"], ["X1", "ONE", "FORD FIESTA AB12CDE", 0, 0], ["X2", "TWO", "KIA RIO CD34EFG", 0, 0]]);
    ws.D2 = { t: "n", v: serial(d, 13, 20), z: "dd/mm/yyyy hh:mm" }; ws.E2 = { t: "n", v: serial(d + 3, 1, 0), z: "dd/mm/yyyy hh:mm" };
    ws.D3 = { t: "n", v: serial(d, 9, 5), z: "dd/mm/yyyy hh:mm" };  ws.E3 = { t: "n", v: serial(d + 5, 22, 40), z: "dd/mm/yyyy hh:mm" };
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "S");
    return XLSX.write(wb, { type: "base64", bookType: "xlsx" });
  }, TONIGHT);
  await page.click("#menuBtn"); await sleep(300); await page.click('#menu [data-view="import"]'); await sleep(300);
  await page.click('[data-impkind="picks"]'); await sleep(200);
  await page.setInputFiles('input[data-file="excel"]', { name: "picks.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(b64, "base64") });
  await sleep(200); await page.click("[data-read]"); await page.waitForSelector("[data-create]", { timeout: 8000 });
  const table = await page.locator(".table-wrap").innerText();
  check("import: Excel date cells keep their exact minutes (13:20, not 13:19)", /13:20/.test(table) && /09:05/.test(table) && !/13:19/.test(table), table.slice(0, 200));
  check("import: the reg is taken from the car description", /AB12CDE/.test(table) && /CD34EFG/.test(table));
  await page.click("[data-create]"); await sleep(800);
  const call = db.calls.find((c) => c.fn === "import_sheet");
  const x1 = call && call.args.p_rows.find((r) => r.ref === "X1");
  check("import: sent to the server with the right day, times and cars", !!x1 && call.args.p_kind === "picks" && call.args.p_day === TONIGHT && call.args.p_rows.length === 2
    && x1.drop_local === TONIGHT + " 13:20" && /01:00$/.test(x1.return_local) && x1.reg === "AB12CDE", x1);
  const gone = await page.locator("#panelBody").innerText().catch(() => "");
  check("import: cars missing from the file are listed, with the moved-day warning", /no longer lists them/.test(gone) && /Only remove cars you know are cancelled/.test(gone));
});

// 18b. Automatic bookings: the office's on/off switch and "Get bookings now".
await scenario(async () => {
  const db = makeDb();
  db.autoImport = { config: { base: "https://example.test/admin/" }, enabled: false, last_ok: null, last_error: null };
  const page = await phone(browser, db, { width: 1000 });
  await open(page);
  await page.click("#menuBtn"); await sleep(300); await page.click('#menu [data-view="import"]'); await sleep(400);
  await page.waitForSelector("[data-autotoggle]", { timeout: 6000 });
  check("auto-import: the Automatic bookings section shows when it's set up", /Automatic bookings/i.test(await page.locator("#main").innerText()));
  check("auto-import: starts off, offering Turn on and Get bookings now", await page.locator("[data-autotoggle]").innerText() === "Turn on" && await page.locator("[data-autorun]").count() === 1);
  await page.click("[data-autotoggle]"); await sleep(400);
  check("auto-import: Turn on reaches the server and flips to Turn off", db.calls.some((c) => c.fn === "set_auto_import" && c.args.p_enabled === true) && await page.locator("[data-autotoggle]").innerText() === "Turn off");
  await page.click("[data-autorun]"); await sleep(900);
  check("auto-import: Get bookings now calls the import function", (db.autoRuns || []).some((x) => x.action === "run"));
  check("auto-import: the result is shown (added / updated)", /Bookings in: 5 added, 1 updated/.test(await toast(page)), await toast(page));
  check("auto-import: no errors", page.__errors.length === 0, page.__errors);
});

// 18c. Without it set up (the usual company), the section stays hidden.
await scenario(async () => {
  const db = makeDb();
  const page = await phone(browser, db, { width: 1000 });
  await open(page);
  await page.click("#menuBtn"); await sleep(300); await page.click('#menu [data-view="import"]'); await sleep(400);
  check("auto-import: hidden for a company without it set up", !/Automatic bookings/i.test(await page.locator("#main").innerText()));
});

// 18a. DROPS file with the date and the time in separate columns (BookingList .xls):
// the time must be read, or every car lands at midnight on the day before.
await scenario(async () => {
  const db = makeDb();
  const page = await phone(browser, db, { width: 1000 });
  await open(page);
  const b64 = await page.evaluate(async (day) => {
    await new Promise((ok, no) => { const s = document.createElement("script"); s.src = "/vendor/xlsx-0.18.5.full.min.js"; s.onload = ok; s.onerror = no; document.head.appendChild(s); });
    const [y, m, d] = day.split("-").map(Number);
    const date = (dd) => (Date.UTC(y, m - 1, dd) - Date.UTC(1899, 11, 30)) / 864e5;
    const ws = XLSX.utils.aoa_to_sheet([["Reference", "Name", "Vehicle", "Drop Off Date", "Drop Off Time", "Return Date", "Return Time"],
      ["T1", "ONE", "FORD FIESTA AB12CDE", 0, 0, 0, 0], ["T2", "TWO", "KIA RIO CD34EFG", 0, 0, 0, 0], ["T3", "THREE", "VW GOLF EF56GHJ", 0, 0, 0, 0]]);
    const put = (c, v, z) => { ws[c] = { t: "n", v, z }; };
    // back on day+1 at 14:30, 21:05 and 03:15 (that one is the night before's shift)
    [[2, 14, 30], [3, 21, 5], [4, 3, 15]].forEach(([r, h, mi]) => {
      put("D" + r, date(d - 5), "dd/mm/yyyy"); put("E" + r, 10 / 24, "hh:mm");
      put("F" + r, date(d + 1), "dd/mm/yyyy"); put("G" + r, (h * 60 + mi) / 1440, "hh:mm");
    });
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "S");
    return XLSX.write(wb, { type: "base64", bookType: "xlsx" });
  }, TONIGHT);
  await page.click("#menuBtn"); await sleep(300); await page.click('#menu [data-view="import"]'); await sleep(300);
  await page.setInputFiles('input[data-file="excel"]', { name: "BookingList.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(b64, "base64") });
  await sleep(200); await page.click("[data-read]"); await page.waitForSelector("[data-create]", { timeout: 8000 });
  const table = await page.locator(".table-wrap").innerText(), btn = await page.locator("[data-create]").innerText();
  const tomorrow = +addDays(TONIGHT, 1).split("-")[2];
  check("import (separate date and time columns): times are read (14:30, 21:05)", /14:30/.test(table) && /21:05/.test(table) && !/00:00/.test(table), table.slice(0, 300));
  check("import (separate date and time columns): the sheet offered is the file's day, not the day before", new RegExp("^" + tomorrow + "(ST|ND|RD|TH) DROPS", "i").test(btn.replace(/^Create /i, "")), btn);
});

// 18a2. BookingList ".xls" that is really tab-separated text: dates must not move an hour (BST).
await scenario(async () => {
  const db = makeDb();
  const page = await phone(browser, db, { width: 1000 });
  await open(page);
  const d1 = addDays(TONIGHT, 1), d2 = addDays(TONIGHT, 2);
  const tsv = ["Sr# \t Reference Number \t Car Reg \t Booking status \t Client \t Booking From \t Drop off Time \t Booking To \t Collection Time \t Car Make \t Inbound Flight No ",
    ["1", "TX1", "AB12CDE", "1", "ONE", TONIGHT, "04:00", d1, "14:30", "FORD", ""].join("\t"),
    ["2", "TX2", "CD34EFG", "1", "TWO", TONIGHT, "09:15", d1, "21:05", "KIA", ""].join("\t"),
    ["3", "TX3", "EF56GHJ", "1", "THREE", TONIGHT, "10:00", d2, "02:10", "VW", ""].join("\t")].join("\n");
  await page.click("#menuBtn"); await sleep(300); await page.click('#menu [data-view="import"]'); await sleep(300);
  await page.setInputFiles('input[data-file="excel"]', { name: "BookingList-test.xls", mimeType: "application/vnd.ms-excel", buffer: Buffer.from(tsv) });
  await sleep(200); await page.click("[data-read]"); await page.waitForSelector("[data-create]", { timeout: 8000 });
  const table = await page.locator(".table-wrap").innerText();
  check("import (text .xls): real times, no hour shift (14:30, 21:05, 02:10)", /14:30/.test(table) && /21:05/.test(table) && !/01:00/.test(table), table.slice(0, 300));
  await page.click("[data-create]"); await sleep(800);
  const call = db.calls.find((c) => c.fn === "import_sheet"), x1 = call && call.args.p_rows.find((r) => r.ref === "TX1");
  check("import (text .xls): drop-off 04:00 and return 14:30 sent as written", !!x1 && x1.drop_local === TONIGHT + " 04:00" && x1.return_local === d1 + " 14:30", x1);
});

// 18a0. DROPS by hour: morning is up to 17:30, night from 17:31
await scenario(async () => {
  const db = makeDb();
  db.bookings.find((x) => x.id === "b1").return_at = new Date(TONIGHT + "T17:30:00+01:00").toISOString();
  db.bookings.find((x) => x.id === "b2").return_at = new Date(TONIGHT + "T17:31:00+01:00").toISOString();
  const page = await phone(browser, db, { width: 1000 });
  await open(page);
  await page.click("#psBtn");
  await sleep(500);
  const body = await page.locator("#panelBody").innerText().catch(() => "");
  const m = body.match(/Morning 06:00–17:30\s+(\d+)/), n = body.match(/Night 17:31–05:59\s+(\d+)/);
  check("DROPS by hour: 17:30 counts as morning, 17:31 as night", !!m && !!n && +m[1] === 1 && +n[1] === 2, body.slice(-400));
});

// 18a3. a file where every car has the same time is refused (the times weren't read)
await scenario(async () => {
  const db = makeDb();
  const page = await phone(browser, db, { width: 1000 });
  await open(page);
  const d1 = addDays(TONIGHT, 1);
  const rows = [" Reference Number \t Car Reg \t Client \t Booking From \t Drop off Time \t Booking To \t Collection Time "];
  for (let i = 1; i <= 6; i++) rows.push(["S" + i, "AB1" + i + "CDE", "N" + i, TONIGHT, "01:00", d1, "01:00"].join("\t"));
  await page.click("#menuBtn"); await sleep(300); await page.click('#menu [data-view="import"]'); await sleep(300);
  await page.click('[data-impkind="picks"]'); await sleep(200);
  await page.setInputFiles('input[data-file="excel"]', { name: "same.xls", mimeType: "application/vnd.ms-excel", buffer: Buffer.from(rows.join("\n")) });
  await sleep(200); await page.click("[data-read]"); await sleep(1500);
  check("import: every car at the same time is refused, nothing sent", /same drop-off time \(01:00\)/.test(await text(page, ".alert")) && !db.calls.some((c) => c.fn === "import_sheet"), await text(page, ".alert"));
});

// 18a3. the menu says which app version this phone runs, and offers a newer one
for (const theme of ["", "board"]) await scenario(async () => {
  const db = theme ? apbDb(theme) : makeDb();
  let tag = '"6bf99e0ff1194dbd"';
  const page = await phone(browser, db);
  await page.route("**/app.js", (route) => route.request().method() === "HEAD" ? route.fulfill({ status: 200, headers: { etag: tag } }) : route.continue());
  await open(page); await sleep(400);
  const openMenu = async () => { await page.evaluate(() => (document.querySelector("#cHead:not(.hidden)") || document.getElementById("menuBtn")).click()); await page.waitForSelector("#menu[open]"); await sleep(400); };
  await openMenu();
  const look = theme || "standard";
  check("App version (" + look + "): the menu shows this phone's version, up to date", /App version 6bf99e0 · up to date/.test(await page.locator("#menuBody .appver").innerText()));
  await page.keyboard.press("Escape"); await sleep(200);
  await page.evaluate(() => { window.__stillHere = true; });
  tag = '"9a1b2c3d4e5f"';
  await openMenu();
  check("App version (" + look + "): after a release, the menu offers the new version", /New version ready/.test(await page.locator("#menuBody .appver").innerText()) && await page.evaluate(() => window.__stillHere === true));
  await page.click("[data-appupdate]"); await sleep(1500);
  check("App version (" + look + "): Update now reloads into the new version", !(await page.evaluate(() => window.__stillHere === true)));
});

// 18a3b. Menu → Tutorials: everyone has it; terminal and bongo see their own videos, others all 7
for (const [theme, role, want] of [["", "owner", 7], ["stdplus", "terminal", 3], ["stdplus", "bongo", 3], ["board", "office", 7]]) await scenario(async () => {
  const db = theme ? apbDb(theme) : makeDb(); db.me = { ...db.me, role };
  const page = await phone(browser, db);
  await open(page); await sleep(400);
  await page.evaluate(() => (document.querySelector("#cHead:not(.hidden)") || document.getElementById("menuBtn")).click()); await page.waitForSelector("#menu[open]"); await sleep(300);
  const look = (theme || "standard") + ", " + role;
  check("Tutorials (" + look + "): the menu has a Tutorials button", await page.locator("#menuBody [data-tutorials]").count() === 1);
  await page.click("#menuBody [data-tutorials]"); await sleep(300);
  const names = await page.locator("#panelBody [data-tutorial]").evaluateAll((b) => b.map((x) => x.dataset.tutorial));
  const ownOnly = role === "terminal" || role === "bongo" ? names.every((n) => n.includes(role)) : true;
  check("Tutorials (" + look + "): the list shows " + want + " videos for this role", names.length === want && ownOnly && !(await page.evaluate(() => document.getElementById("menu").open)), names.join(","));
  await page.click("#panelBody [data-tutorial]"); await sleep(600);
  const src = await page.locator("#panelBody video").getAttribute("src");
  check("Tutorials (" + look + "): tapping one plays it in the app", src === "/tutorials/" + names[0] + ".mp4" && await page.evaluate(() => document.querySelector("#panelBody video").controls));
  const head = await page.evaluate(async (u) => (await fetch(u, { method: "HEAD" })).status, src);
  check("Tutorials (" + look + "): the video file is there", head === 200, String(head));
  await page.click('#panelBody [data-tutorials]'); await sleep(300);
  check("Tutorials (" + look + "): All videos goes back to the list", await page.locator("#panelBody [data-tutorial]").count() === want);
  await page.click("#panelBody [data-tutorial]"); await sleep(400);
  await page.keyboard.press("Escape"); await sleep(300);
  check("Tutorials (" + look + "): closing stops the video", await page.evaluate(() => { const v = document.querySelector("#panelBody video"); return !v || v.paused; }));
});

// 18a3c. Menu → Dashboard (owner, managers): cars added at the desk, money taken and owed, removed cars, complaints
let db0Yard = "NB";
const dashData = () => {
  const ago = (h) => new Date(Date.now() - h * 3600000).toISOString();
  return {
    added: [{ at: ago(2), reg: "AB12CDE", customer: "MR WALK IN", staff_name: "SUGU", action: "ADDED", value: "added by hand", kind: "drops" },
      { at: ago(5), reg: "XY34ZZZ", customer: "MRS DESK", staff_name: "TERRY", action: "CALLED", value: "New Booking", kind: "picks" }],
    paid: [{ id: "p1", reg: "CASH01", name: "MR CASH", charge_amount: 20, charge_method: "cash", charge_at: ago(3), charge_reason: "", by_name: "SUGU" },
      { id: "p2", reg: "CARD01", name: "MR CARD", charge_amount: 50, charge_method: "card", charge_at: ago(4), charge_reason: "return date changed", by_name: "SUGU" },
      { id: "p3", reg: "WAIVE1", name: "MR FREE", charge_amount: 30, charge_method: "waived", charge_at: ago(6), charge_reason: "", by_name: "RAKESH" }],
    owed: [{ id: "o1", kind: "drops", reg: "OWE001", name: "MR HERE", return_at: ago(30), cleared_at: null, overstay: true, charge_agreed: 40, charge_reason: "" },
      { id: "o2", kind: "drops", reg: "LEFT01", name: "MR GONE", return_at: ago(80), cleared_at: ago(1), overstay: true, charge_agreed: null, charge_reason: "" },
      { id: "o3", kind: "drops", reg: "ZERO01", name: "MR ONTIME", return_at: ago(1), cleared_at: null, overstay: true, charge_agreed: null, charge_reason: "" }],
    removed: [{ id: "r1", kind: "picks", reg: "NOSHOW1", name: "MR AWAY", removed_reason: "No show", removed_at: ago(7), by_name: "SUGU" }],
    complaints: [{ at: ago(8), reg: "MAD001", customer: "MR CROSS", staff_name: "TERRY" }],
    early: 2, changed: 3,
    onsite: (() => { const lp = new Date().toLocaleString("sv-SE", { timeZone: "Europe/London" }); const base = new Date(lp.slice(0, 10) + "T12:00:00Z"); if (lp.slice(11, 16) <= "06:00") base.setUTCDate(base.getUTCDate() - 1); return [38, 45, 30, 12].map((n, i) => ({ day: new Date(base.getTime() + i * 864e5).toISOString().slice(0, 10), here: n, in: 4 + i, out: 6 + i })); })(),
    parked: { total: 30, late: 2, late_cars: [{ reg: "LATE1", name: "Old Car", return_at: new Date(Date.now() - 2.5 * 86400000).toISOString(), yard: "NB" }, { reg: "LATE2", name: "New Car", return_at: new Date(Date.now() - 3600000).toISOString(), yard: "" }], days: [{ day: new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" }), n: 8 }, { day: new Date(Date.now() + 2 * 86400000).toLocaleDateString("en-CA", { timeZone: "Europe/London" }), n: 20 }],
      yards: [{ yard: "", n: 12, days: [{ day: null, n: 2 }, { day: new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" }), n: 10 }] }, { yard: db0Yard, n: 18, days: [{ day: new Date(Date.now() + 2 * 86400000).toLocaleDateString("en-CA", { timeZone: "Europe/London" }), n: 18 }] }] }
  };
};
for (const theme of ["", "stdplus"]) await scenario(async () => {
  const db = makeDb(); if (theme) db.company.brand = { theme, colour: "#F9A01B", ink: "#172536", short: "TakeOff" }; db.company.overstay_rate = 30; db.dash = dashData();
  const page = await phone(browser, db);
  await open(page); await sleep(400);
  const look = theme || "standard";
  await page.evaluate(() => (document.querySelector("#cHead:not(.hidden)") || document.getElementById("menuBtn")).click()); await page.waitForSelector("#menu[open]"); await sleep(300);
  check("Dashboard (" + look + "): the owner's menu has Dashboard", await page.locator('#menuBody [data-view="dashboard"]').count() === 1);
  await page.click('#menuBody [data-view="dashboard"]'); await sleep(700);
  const tiles = await page.locator("#main .dstats .stat").evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()));
  const tile = (name) => tiles.find((t) => t.startsWith(name)) || "";
  if (theme === "stdplus") {
    check("Dashboard: compact layout fits a phone", await noSideScroll(page));
    check("Dashboard: occupancy and payments stack on a phone", await page.locator('.ops-topgrid').evaluate((e) => {
      const occupancy = e.children[0].getBoundingClientRect(), payments = e.children[1].getBoundingClientRect();
      return payments.top >= occupancy.bottom && Math.abs(payments.left - occupancy.left) < 2;
    }));
    check("Dashboard: enterprise heading and navy occupancy panel", await page.locator(".dash-heading h1").isVisible() && await page.locator(".k-parked").evaluate((e) => getComputedStyle(e).backgroundColor === "rgb(15, 28, 46)"));
    if (process.env.SHOT_DIR) {
      await page.screenshot({ path: process.env.SHOT_DIR + "/dashboard-mobile.png", fullPage: false });
      await page.setViewportSize({ width: 1440, height: 1000 });
      check("Dashboard: compact layout fits desktop", await noSideScroll(page));
      await page.screenshot({ path: process.env.SHOT_DIR + "/dashboard-desktop.png", fullPage: false });
    }
  }
  check("Dashboard (" + look + "): cars added at the desk, by hand and NEW BOOKING", /^Added at the desk 2 1 added · 1 NEW BOOKING/.test(tile("Added at the desk")), tile("Added at the desk"));
  check("Dashboard (" + look + "): money taken, cash and card", /Money taken £70 cash £20 · card £50/.test(tile("Money taken")), tile("Money taken"));
  check("Dashboard (" + look + "): owed now only counts cars still here that owe something", /Owed now £40 1 car here/.test(tile("Owed now")), tile("Owed now"));
  check("Dashboard (" + look + "): a car that left with no payment recorded shows red", /^Left unpaid £(\d+) 1 car/.test(tile("Left unpaid")) && +tile("Left unpaid").match(/£(\d+)/)[1] >= 60 && await page.locator("#main .dstats .stat.warn").count() === 1, tile("Left unpaid"));
  check("Dashboard (" + look + "): waived, removed, complaints, early returns", /Waived £30 1 car/.test(tile("Waived")) && /Removed 1 1 no show/.test(tile("Removed")) && /Complaints 1/.test(tile("Complaints")) && /Early returns 2 3 return changes/.test(tile("Early returns")), tiles.join(" | "));
  if (theme === "stdplus") await page.locator('.ops-record').evaluateAll((els) => els.forEach((e) => { e.open = true; }));
  const body = await page.locator("#main").innerText();
  check("Dashboard (" + look + "): the lists name the cars and who did it", /Left with no payment recorded \(1\)[\s\S]*LEFT01/i.test(body) && /AB12CDE[\s\S]*Added to DROPS · SUGU/.test(body) && /XY34ZZZ[\s\S]*Marked NEW BOOKING · TERRY/.test(body) && /CARD01[\s\S]*CARD · return date changed · SUGU/.test(body) && !/ZERO01/.test(body), body.slice(0, 400));
  check("Dashboard (" + look + "): Parked now counts the cars in, with those past their return", /^Parked now 30 2 past their return/.test(tile("Parked now")), tile("Parked now"));
  check("Dashboard (" + look + "): parked cars by yard, yards first, no yard last", /Parked now, by yard\s*NB\s*\S*\s*\w{3},? \d+ \w{3} 18\s*18\s*No yard yet\s*past return 2 · Today 10\s*12/i.test(body), (body.match(/Parked now, by yard[\s\S]{0,160}/i) || [""])[0]);
  check("Dashboard (" + look + "): no capacity set, no spaces shown", !/ free|\/ \d/.test(tile("Parked now")) && await page.locator(".ops-capbar").count() === 0);
  check("Dashboard (" + look + "): parked cars by return day, past return first", theme === "stdplus" ? /Past their return[\s\S]*?2\s*Today\s*8\s*\w{3},? \d+ \w{3}\s*20/i.test(await page.locator('#dash-returns').innerText()) : /Parked now, by return day\s*Past their return[\s\S]*?2\s*Today\s*8\s*\w{3},? \d+ \w{3}\s*20/i.test(body), body.slice(0, 160));
  await page.evaluate(() => { const d = document.querySelector("#main details.latebox, #main details.ops-latebox"); if (d) d.open = true; }); await sleep(150);
  const lateTxt = await page.locator("#main details.latebox, #main details.ops-latebox").first().innerText().catch(() => "");
  check("Dashboard (" + look + "): Past their return opens to list the cars by level", /LATE1/.test(lateTxt) && /LATE2/.test(lateTxt) && /2 days/.test(lateTxt) && /Less than a day/.test(lateTxt), lateTxt);
  const bookedTxt = (await page.locator("#main .booked").first().innerText().catch(() => "")).replace(/\s+/g, " ");
  check("Dashboard (" + look + "): cars on site per day shows the days counted by the app", /Busiest: Tomorrow 45/.test(bookedTxt) && /Today\s*38/.test(bookedTxt) && /\+5 in · 7 out/.test(bookedTxt), bookedTxt);
  check("Dashboard (" + look + "): no paste box, nothing to copy from another site", await page.locator("#bookedText, [data-savebooked]").count() === 0);
  const first = new Date(db.dashCalls[0]).getTime();
  check("Dashboard (" + look + "): opens on the last 7 days", Math.abs(Date.now() - first - 7 * 86400000) < 600000);
  await page.click('#main [data-dashp="30"]'); await sleep(600);
  const last = new Date(db.dashCalls[db.dashCalls.length - 1]).getTime();
  check("Dashboard (" + look + "): 30 days reads again from 30 days back", Math.abs(Date.now() - last - 30 * 86400000) < 600000 && await page.locator('#main [data-dashp="30"].on').count() === 1);
  if (theme === "stdplus") {
    check("Dashboard: period label follows the filter", /Last 30 days/.test(await page.locator('.ops-topgrid').innerText()));
    const calls = db.dashCalls.length;
    await page.click('[data-dashjump="owed"]');
    check("Dashboard: owed metric opens the correct records and focuses them", await page.locator('#dash-owed').getAttribute('open') !== null && /OWE001/.test(await page.locator('#dash-owed').innerText()) && await page.locator('#dash-owed summary').evaluate((e) => e === document.activeElement));
    await page.click('.ops-attention [data-dashjump="unpaid"]');
    check("Dashboard: unpaid alert opens its matching records", await page.locator('#dash-unpaid').getAttribute('open') !== null && /LEFT01/.test(await page.locator('#dash-unpaid').innerText()) && db.dashCalls.length === calls);
    await page.click('.ops-attention [data-dashjump="returns"]');
    check("Dashboard: overdue alert focuses the return breakdown", await page.locator('#dash-returns').evaluate((e) => e === document.activeElement));
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
    const laterDay = addDays(today, 7);
    db.dash.parked.days.push({ day: laterDay, n: 9 }); db.dash.parked.total += 9;
    await page.click('[data-dashreload]'); await sleep(650);
    check("Dashboard: refresh reloads and shows a genuine update time", db.dashCalls.length === calls + 1 && /Updated at \d{2}:\d{2}/.test(await page.locator('.ops-updated').innerText()));
    check("Dashboard: seven-day schedule hides later dates and counts them", await page.locator('.ops-returnrow').count() === 3 && /9 cars returning later/.test(await page.locator('.ops-tablefoot').innerText()));
    await page.click('[data-dashdates]');
    check("Dashboard: view all dates reveals later returns without a new request", await page.locator('.ops-returnrow').count() === 4 && await page.locator('[data-dashdates]').getAttribute('aria-expanded') === 'true' && db.dashCalls.length === calls + 1);
    await page.click('[data-dashdates]');
    check("Dashboard: dates collapse again and keyboard focus remains on the control", await page.locator('.ops-returnrow').count() === 3 && await page.locator('[data-dashdates]').evaluate((e) => e === document.activeElement));
    db.dash = { parked: { total: 0, late: 0, days: [], yards: [] } };
    await page.click('[data-dashreload]'); await sleep(650);
    check("Dashboard: empty data has no false alerts or dead date controls", await page.locator('.ops-attention').count() === 0 && await page.locator('[data-dashdates]').count() === 0 && /No upcoming returns/.test(await page.locator('#dash-returns').innerText()));
    await page.setViewportSize({ width: 360, height: 800 });
    check("Dashboard: smallest phone fits the interactive layout", await noSideScroll(page));
  }
});
// Capacity (Settings, part 71) against Parked now: spaces free or over, per yard too
for (const theme of ["", "stdplus"]) await scenario(async () => {
  const db = makeDb(); if (theme) db.company.brand = { theme, colour: "#F9A01B", ink: "#172536", short: "TakeOff" }; db.dash = dashData();
  db.company.capacity = 40; db.company.yard_capacity = { NB: 15 };
  const page = await phone(browser, db);
  await open(page); await sleep(400);
  const look = theme || "standard";
  await page.evaluate(() => (document.querySelector("#cHead:not(.hidden)") || document.getElementById("menuBtn")).click()); await page.waitForSelector("#menu[open]"); await sleep(300);
  await page.click('#menuBody [data-view="dashboard"]'); await sleep(700);
  const parked = (await page.locator("#main .dstats .k-parked").innerText()).replace(/\s+/g, " ");
  check("Capacity (" + look + "): Parked now shows the spaces free", /30 of 40 · 10 free/.test(parked), parked);
  const onsiteTxt = (await page.locator("#main .booked").first().innerText().catch(() => "")).replace(/\s+/g, " ");
  check("Capacity (" + look + "): cars on site shows spaces free and over each day", /Today\s*38\s*2 free/.test(onsiteTxt) && /Tomorrow\s*45\s*5 over/.test(onsiteTxt) && await page.locator(".booked-row.over").count() === 1, onsiteTxt);
  const yard = (await page.locator("#main").innerText()).match(/NB[\s\S]{0,80}/)[0].replace(/\s+/g, " ");
  check("Capacity (" + look + "): a yard over its spaces shows red", /18 \/ 15/.test(yard) && await page.locator("#main strong.num.late").count() === 1, yard);
  if (process.env.SHOT_DIR) await page.screenshot({ path: process.env.SHOT_DIR + "/capacity-dashboard-" + look + ".png", fullPage: true });
  if (theme === "stdplus") check("Capacity: occupancy bar three quarters full", await page.locator(".ops-capbar i").evaluate((e) => e.style.width) === "75%");
  db.dash.parked.total = 45; await page.click("[data-dashreload]"); await sleep(650);
  const over = (await page.locator("#main .dstats .k-parked").innerText()).replace(/\s+/g, " ");
  check("Capacity (" + look + "): over capacity says how many", /45 of 40 · 5 over/.test(over), over);
  check("Capacity (" + look + "): fits a phone", await noSideScroll(page));
});
await scenario(async () => {
  const db = makeDb(); db.me.role = "office";
  db.perms = Object.fromEntries(["sent", "called", "clear", "yard", "summary", "log", "flights", "rtc", "picksinfo", "import", "staff", "note", "intake"].map((k) => [k, true]));
  const page = await phone(browser, db);
  await open(page); await sleep(400);
  await page.click("#menuBtn"); await sleep(300);
  check("Dashboard: office staff don't get it", await page.locator('#menuBody [data-view="dashboard"]').count() === 0 && await page.locator('#menuBody [data-view="archive"]').count() === 1);
});

// 18a3d. Location on PICKS (brand.picks_yard): the row's NO SHOW becomes the location, NO SHOW is in the panel, yards counted
for (const [theme, role] of [["", "owner"], ["stdplus", "terminal"]]) await scenario(async () => {
  const db = theme ? apbDb(theme) : makeDb(); db.company.brand = { ...db.company.brand, picks_yard: true }; db.me = { ...db.me, role };
  if (role === "terminal") db.perms = { clear: true, picksinfo: true, note: true, intake: true };
  const yards = db.company.yards;
  const page = await phone(browser, db);
  await open(page); await sleep(300);
  if (await page.locator("#kindSeg:not(.hidden)").count()) await page.click("#kindSeg [data-kind=picks]"); else await page.selectOption("#sheetPick", "p0");
  await page.waitForSelector('.row[data-id="p1"]');
  const look = (theme || "standard") + ", " + role;
  const row = '.row[data-id="p1"]';
  check("Location on PICKS (" + look + "): the row has a location button, not NO SHOW", await page.locator(row + ' [data-pick="No Show"]').count() === 0 && await page.locator(row + " .pyard select[data-yard]").count() === 1
    && (await page.locator(row + " .pyard select option").allInnerTexts()).length === yards.length + 1);
  const yardCounts = async () => page.locator("#tally .tyards button").evaluateAll((b) => b.map((x) => x.innerText.replace(/\s+/g, " ").trim()));
  const before = await yardCounts();
  check("Location on PICKS (" + look + "): the column heading says YARD", /COLL\s*YARD\s*RTC/.test(await page.locator("#colHead").innerText()));
  check("Location on PICKS (" + look + "): the numbers count cars per yard on their own line", before.length >= yards.length && /^\S+.* 0$/.test(before[0]), before);
  await page.selectOption(row + " .pyard select", yards[1]); await sleep(500);
  const call = db.calls.filter((c) => c.fn === "set_yard").pop();
  check("Location on PICKS (" + look + "): choosing a location saves it", call && call.args.p_booking === "p1" && call.args.p_yard === yards[1], call);
  check("Location on PICKS (" + look + "): the button then shows the location", (await page.locator(row + " .pyard.on span").innerText()).length > 0);
  const after = await yardCounts();
  check("Location on PICKS (" + look + "): that yard's count goes up", after[1] && / 1$/.test(after[1]), after);
  await page.click(row + " .reg"); await page.waitForSelector("#panel[open]");
  check("Location on PICKS (" + look + "): NO SHOW is in the car's panel", await page.locator("#panelBody [data-pnoshow]").count() === 1);
  await page.click("#panelBody [data-pnoshow]"); await sleep(500);
  const tp = db.calls.filter((c) => c.fn === "tap_pick").pop();
  check("Location on PICKS (" + look + "): NO SHOW from the panel marks the car", tp && tp.args.p_booking === "p1" && tp.args.p_key === "intake" && tp.args.p_value === "No Show", tp);
});
await scenario(async () => {
  const db = makeDb();
  const page = await phone(browser, db);
  await open(page); await sleep(300);
  if (await page.locator("#kindSeg:not(.hidden)").count()) await page.click("#kindSeg [data-kind=picks]"); else await page.selectOption("#sheetPick", "p0");
  await page.waitForSelector('.row[data-id="p1"]');
  check("Location on PICKS: switched off, rows keep NO SHOW and no yard counts", await page.locator('.row[data-id="p1"] [data-pick="No Show"]').count() === 1 && await page.locator(".pyard").count() === 0 && await page.locator("#tally .tyards").count() === 0);
});

// 18a3d2. Exit fee (companies.exit_fee / exit_free, database part 76): exempt references get NO EXIT FEE on DROPS, the car says the fee
for (const theme of ["", "stdplus", "ops", "premium", "board", "cards", "pro"]) await scenario(async () => {
  const db = theme ? apbDb(theme) : makeDb(); db.company.exit_fee = 10; db.company.exit_free = ["CPD", "VIPAPB1147"];
  const drops = db.bookings.filter((x) => x.kind === "drops" && x.sheet_id === db.bookings[0].sheet_id);
  drops[0].ref = "Cpd - 19-660374"; drops[1].ref = "CAP-18-554625"; if (drops[2]) drops[2].ref = "vip apb-1147";
  const page = await phone(browser, db);
  await open(page); await sleep(300);
  const look = theme || "standard";
  const r0 = '.row[data-id="' + drops[0].id + '"]', r1 = '.row[data-id="' + drops[1].id + '"]';
  await page.waitForSelector(r0);
  check("Exit fee (" + look + "): a listed reference start shows NO EXIT FEE, any case or spacing", /NO EXIT FEE/.test(await page.locator(r0).innerText()));
  if (drops[2]) check("Exit fee (" + look + "): a whole listed reference shows NO EXIT FEE", /NO EXIT FEE/.test(await page.locator('.row[data-id="' + drops[2].id + '"]').innerText()));
  check("Exit fee (" + look + "): other references show no tag", !/EXIT FEE/.test(await page.locator(r1).innerText()));
  await page.click(r0 + " .reg"); await page.waitForSelector("#panel[open]");
  check("Exit fee (" + look + "): the car says no exit fee", /EXIT FEE\s*None for this booking/i.test(await page.locator("#panelBody .det").innerText()));
  await page.click("#panelBody [data-close]"); await sleep(200);
  await page.click(r1 + " .reg"); await page.waitForSelector("#panel[open]");
  check("Exit fee (" + look + "): the car says the fee", /EXIT FEE\s*£10\b/i.test(await page.locator("#panelBody .det").innerText()));
});
await scenario(async () => {
  const db = makeDb(); db.company.exit_free = ["R"];
  const page = await phone(browser, db);
  await open(page); await sleep(300);
  await page.waitForSelector('.row[data-id="b1"]');
  check("Exit fee: no fee set, no tag and nothing in the car", !/EXIT FEE/.test(await page.locator("#main").innerText()));
  await page.click('.row[data-id="b1"] .reg'); await page.waitForSelector("#panel[open]");
  check("Exit fee: no fee set, the car doesn't mention it", !/EXIT FEE/i.test(await page.locator("#panelBody").innerText()));
});
// Exit fee: paid by cash or card with a photo; Undo; without a photo.
for (const theme of ["", "ops"]) await scenario(async () => {
  const db = makeDb(); if (theme) db.company.brand = { theme, colour: "#F9A01B", ink: "#172536", short: "TakeOff" };
  db.company.exit_fee = 10; db.company.exit_free = ["CAP"]; db.me = { ...db.me, role: "terminal" }; db.perms = { clear: true, picksinfo: true, note: true, intake: true };
  const page = await phone(browser, db);
  await open(page); await sleep(300);
  const look = theme || "standard";
  await page.click('.row[data-id="b1"] .reg'); await page.waitForSelector("#panel[open]");
  check("Exit fee paid (" + look + "): the car shows £10 due with CASH and CARD", /£10 due/.test(await page.locator("#panelBody").innerText()) && await page.locator("[data-exitshot]").count() === 2);
  await page.evaluate(() => { document.getElementById("exitFile").click = () => {}; }); await page.click('[data-exitshot="card"]');
  await page.setInputFiles("#exitFile", path.join(ROOT, "icons/icon-512.png"));
  await sleep(1500);
  const call = db.calls.filter((c) => c.fn === "set_exit_paid").pop();
  check("Exit fee paid (" + look + "): CARD with a photo uploads it and marks the car", call && call.args.p_method === "card" && /^c1\/docs\/b1\/x\d+\.jpg$/.test(call.args.p_photo) && db.uploads.some((u) => u === call.args.p_photo), { call, up: db.uploads });
  check("Exit fee paid (" + look + "): the car says paid by card, with the photo", /£10 paid by card/.test(await page.locator("#panelBody").innerText()) && await page.locator("#exitImg").count() === 1);
  await page.keyboard.press("Escape"); await sleep(300);
  check("Exit fee paid (" + look + "): the row shows EXIT £10 CARD", /EXIT £10 CARD/.test(await page.locator('.row[data-id="b1"]').innerText()));
  await page.click('.row[data-id="b1"] .reg'); await page.waitForSelector("#panel[open]");
  await page.click("[data-exitundo]"); await sleep(600);
  check("Exit fee paid (" + look + "): Undo clears it", db.calls.filter((c) => c.fn === "set_exit_paid").pop().args.p_method === "" && /£10 due/.test(await page.locator("#panelBody").innerText()));
  await page.click('[data-exitnophoto="cash"]'); await sleep(600);
  const c2 = db.calls.filter((c) => c.fn === "set_exit_paid").pop();
  check("Exit fee paid (" + look + "): cash without a photo is marked too", c2.args.p_method === "cash" && c2.args.p_photo === "" && /No photo of the payment/.test(await page.locator("#panelBody").innerText()));
});
// Exit fee in Settings: owners only.
for (const role of ["owner", "manager"]) await scenario(async () => {
  const db = makeDb(); db.me = { ...db.me, role };
  if (role === "manager") db.perms = Object.fromEntries(["sent", "called", "clear", "yard", "summary", "log", "flights", "rtc", "picksinfo", "import", "staff", "note", "intake", "settings"].map((k) => [k, true]));
  const page = await phone(browser, db);
  await open(page); await sleep(300);
  await page.click("#menuBtn"); await sleep(300); await page.click('#menuBody [data-view="settings"]'); await sleep(400);
  if (role === "manager") return check("Exit fee settings: a manager doesn't get them", await page.locator("[data-saveexit]").count() === 0 && await page.locator("[data-saverate]").count() === 1);
  check("Exit fee settings: the owner gets them, off to start", await page.locator("[data-saveexit]").count() === 1 && await page.inputValue("#exitFee") === "");
  await page.fill("#exitFee", "10"); await page.fill("#exitFree", "cap, APD, VIP APB-1147"); await page.click("[data-saveexit]"); await sleep(500);
  const c = db.calls.filter((x) => x.fn === "set_exit_fee").pop();
  check("Exit fee settings: saving sends the fee and the references", c && c.args.p_fee === 10 && JSON.stringify(c.args.p_free) === JSON.stringify(["cap", "APD", "VIP APB-1147"]), c);
  await page.click("#menuBtn"); await sleep(300); await page.click('#menuBody [data-view="board"]').catch(() => {}); await sleep(300);
});

// 18a3d3. Yard colours (companies.yard_colours, database part 77): each yard's tag on DROPS, the PICKS location button and the car's yard buttons
const YC = { MY: "#2E7D32", GS: "#EF6C00", T: "#FBC02D" };
const rgb = (h) => "rgb(" + [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(", ") + ")";
for (const theme of ["", "stdplus", "ops", "premium", "board", "cards", "pro"]) await scenario(async () => {
  const db = apbDb(theme || "standard"); if (!theme) db.company.brand = { ...db.company.brand, theme: undefined };
  db.company.brand = { ...db.company.brand, picks_yard: true }; db.company.yard_colours = YC;
  const sid = db.bookings[0].sheet_id, drops = db.bookings.filter((x) => x.kind === "drops" && x.sheet_id === sid);
  drops[0].yard = "MY"; drops[1].yard = "GS"; if (drops[2]) drops[2].yard = "T";
  const page = await phone(browser, db);
  await open(page); await sleep(300);
  const look = theme || "standard";
  const bg = (sel) => page.locator(sel).first().evaluate((e) => getComputedStyle(e).backgroundColor);
  await page.waitForSelector('.row[data-id="' + drops[0].id + '"] .code');
  check("Yard colours (" + look + "): MY's tag on DROPS is green", await bg('.row[data-id="' + drops[0].id + '"] .code') === rgb(YC.MY));
  check("Yard colours (" + look + "): GS's tag on DROPS is orange", await bg('.row[data-id="' + drops[1].id + '"] .code') === rgb(YC.GS));
  if (drops[2]) check("Yard colours (" + look + "): T's tag on DROPS is yellow, with dark text", await bg('.row[data-id="' + drops[2].id + '"] .code') === rgb(YC.T)
    && await page.locator('.row[data-id="' + drops[2].id + '"] .code').evaluate((e) => getComputedStyle(e).color) === "rgb(31, 26, 0)");
  await page.click('.row[data-id="' + drops[0].id + '"] .reg'); await page.waitForSelector("#panel[open]");
  check("Yard colours (" + look + "): the car's chosen yard button is green", await bg('#panelBody [data-setyard="MY"]') === rgb(YC.MY));
  await page.click("#panelBody [data-close]"); await sleep(300);
  if (await page.locator("#kindBar [data-kind=picks]:visible").count()) await page.click("#kindBar [data-kind=picks]"); else if (await page.locator("#kindSeg:not(.hidden)").count()) await page.click("#kindSeg [data-kind=picks]"); else await page.selectOption("#sheetPick", "p0");
  await page.waitForSelector('.row[data-id="p1"] .pyard');
  await page.selectOption('.row[data-id="p1"] .pyard select', "GS"); await sleep(500);
  check("Yard colours (" + look + "): the PICKS location button is orange for GS", await bg('.row[data-id="p1"] .pyard.on') === rgb(YC.GS));
});
await scenario(async () => {
  const db = apbDb("ops"), plain = apbDb("ops");
  const sid = db.bookings[0].sheet_id, d0 = db.bookings.filter((x) => x.kind === "drops" && x.sheet_id === sid)[0];
  d0.yard = "T"; plain.bookings.find((x) => x.id === d0.id).yard = "T";
  db.company.yard_colours = { MY: "#2E7D32" };
  const a = await phone(browser, db), b = await phone(browser, plain);
  await open(a); await open(b); await sleep(300);
  const sel = '.row[data-id="' + d0.id + '"] .code';
  await a.waitForSelector(sel); await b.waitForSelector(sel);
  const st = (p) => p.locator(sel).evaluate((e) => { const c = getComputedStyle(e); return c.backgroundColor + c.color; });
  check("Yard colours: a yard with no colour keeps the look's own", await st(a) === await st(b));
});
// Yard colours in Settings: owners only.
for (const role of ["owner", "manager"]) await scenario(async () => {
  const db = apbDb("ops"); db.me = { ...db.me, role }; db.company.yard_colours = { MY: "#2E7D32" };
  if (role === "manager") db.perms = Object.fromEntries(["sent", "called", "clear", "yard", "summary", "log", "flights", "rtc", "picksinfo", "import", "staff", "note", "intake", "settings"].map((k) => [k, true]));
  const page = await phone(browser, db);
  await open(page); await sleep(300);
  await page.click("#menuBtn"); await sleep(300); await page.click('#menuBody [data-view="settings"]'); await sleep(400);
  if (role === "manager") return check("Yard colours settings: a manager doesn't get them", await page.locator("[data-saveycol]").count() === 0 && await page.locator("[data-savecap]").count() === 1);
  check("Yard colours settings: the owner gets a colour per yard", await page.locator("[data-ycol]").count() === 3 && await page.inputValue('[data-ycol="MY"]') === "#2e7d32");
  await page.locator('[data-ycol="GS"]').evaluate((e) => { e.value = "#ef6c00"; e.dispatchEvent(new Event("input", { bubbles: true })); });
  check("Yard colours settings: the tag shows the colour as it's chosen", await page.locator('.ycol:has([data-ycol="GS"]) .code').evaluate((e) => getComputedStyle(e).backgroundColor) === rgb("#EF6C00"));
  await page.click('[data-ycoff="MY"]');
  await page.click("[data-saveycol]"); await sleep(500);
  const c = db.calls.filter((x) => x.fn === "set_yard_colours").pop();
  check("Yard colours settings: saving sends each yard's colour, blank for none", c && c.args.p_colours.GS === "#ef6c00" && c.args.p_colours.MY === "" && c.args.p_colours.T === "", c);
  check("Yard colours settings: saved colours apply at once", await page.locator('.ycol:has([data-ycol="GS"]) .code').evaluate((e) => getComputedStyle(e).backgroundColor) === rgb("#EF6C00")
    && await page.locator('[data-ycol="MY"][data-off]').count() === 1);
});

// 18a3e. PICKS: a new booking at the desk, with a photo of the docket (database part 69)
for (const [theme, role] of [["", "office"], ["stdplus", "terminal"]]) await scenario(async () => {
  const db = theme ? apbDb(theme) : makeDb(); db.me = { ...db.me, role }; db.company.brand = { ...db.company.brand, picks_yard: true };
  if (role === "terminal") db.perms = { clear: true, picksinfo: true, note: true, intake: true };
  const page = await phone(browser, db);
  await open(page); await sleep(300);
  const look = (theme || "standard") + ", " + role;
  check("Desk booking (" + look + "): no button on DROPS", await page.locator("[data-deskbook]").count() === 0);
  if (await page.locator("#kindSeg:not(.hidden)").count()) await page.click("#kindSeg [data-kind=picks]"); else await page.selectOption("#sheetPick", "p0");
  await page.waitForSelector('.row[data-id="p1"]');
  check("Desk booking (" + look + "): PICKS has the + New booking button", await page.locator("[data-deskbook]").count() === 1);
  await page.click("[data-deskbook]"); await page.waitForSelector("#deskForm");
  await page.setInputFiles("[data-deskfile]", path.join(ROOT, "icons/icon-512.png")); await sleep(200);
  check("Desk booking (" + look + "): the docket photo shows as taken", /Docket photo taken/.test(await page.textContent("#dkShot")));
  await page.fill("#dkReg", "bu15dde"); await page.fill("#dkName", "MR DESK"); await page.fill("#dkRetD", addDays(TONIGHT, 4)); await page.fill("#dkRetT", "05:15");
  await page.click('#dkYard [data-dkyard="' + db.company.yards[0] + '"]');
  check("Desk booking (" + look + "): Car taken in now is ticked to start with", await page.isChecked("#dkIn"));
  await page.click("#dkGo"); await sleep(1500);
  const call = db.calls.find((c) => c.fn === "add_booking");
  check("Desk booking (" + look + "): saved as a desk booking, taken in, with its location", call && call.args.p_sheet === "p0" && call.args.p.desk === true && call.args.p.taken_in === true && call.args.p.yard === db.company.yards[0] && call.args.p.return_local === addDays(TONIGHT, 4) + " 05:15", call && call.args);
  const doc = db.calls.find((c) => c.fn === "set_doc");
  const up = db.uploads.find((u) => /\/docs\//.test(u));
  check("Desk booking (" + look + "): the docket photo is uploaded and kept with the car", doc && up && new RegExp("^" + db.company.id + "/docs/" + doc.args.p_booking + "/\\d+\\.jpg$").test(doc.args.p_path) && up === doc.args.p_path, { doc: doc && doc.args, up });
  await page.click("#tabAll"); await sleep(300);
  check("Desk booking (" + look + "): the car is on the board, NEW BOOKING", /BU15DDE/.test(await page.textContent("#main")) && /NEW BOOKING/.test(await page.textContent("#main")));
  const nb = db.bookings.find((b) => b.reg === "BU15DDE");
  await page.click('.row[data-id="' + nb.id + '"] .reg'); await page.waitForSelector("#panel[open]"); await sleep(600);
  const src = await page.locator("#docImg img").getAttribute("src").catch(() => "");
  check("Desk booking (" + look + "): the car's panel shows the docket photo", /object\/sign\/pt-photos\/.*docs/.test(src || ""), src);
});
await scenario(async () => {
  const db = makeDb(); db.me = { ...db.me, role: "view" }; db.perms = { };
  const page = await phone(browser, db);
  await open(page); await sleep(300);
  await page.selectOption("#sheetPick", "p0"); await page.waitForSelector('.row[data-id="p1"]');
  check("Desk booking: view-only staff don't get the button", await page.locator("[data-deskbook]").count() === 0);
});

// 18a3f. Me → Copy my link: this phone's own personal link
for (const theme of ["", "stdplus"]) await scenario(async () => {
  const db = theme ? apbDb(theme) : makeDb();
  const page = await phone(browser, db);
  await open(page); await sleep(300);
  await page.evaluate(() => { window.__copied = []; navigator.clipboard.writeText = async (x) => { window.__copied.push(x); }; });
  await page.evaluate(() => (document.querySelector("#cHead:not(.hidden)") || document.getElementById("menuBtn")).click()); await page.waitForSelector("#menu[open]"); await sleep(200);
  await page.click('#menuBody [data-view="me"]'); await sleep(400);
  const look = theme || "standard";
  check("Copy my link (" + look + "): Me has the button", await page.locator(".mylink [data-copy]").count() === 1);
  await page.click(".mylink [data-copy]"); await sleep(300);
  const want = await page.evaluate(() => location.origin + "/#t=" + localStorage.getItem("takeoff_link"));
  const got = await page.evaluate(() => window.__copied[0]);
  check("Copy my link (" + look + "): copies this phone's link", got === want && /#t=[A-Za-z0-9_-]{32,64}$/.test(got), { got, want });
});

// 18a4. a new version of the app is picked up without anyone reloading
await scenario(async () => {
  const db = makeDb();
  let tag = '"v1"';
  const page = await phone(browser, db);
  await page.route("**/app.js", (route) => route.request().method() === "HEAD" ? route.fulfill({ status: 200, headers: { etag: tag } }) : route.continue());
  await open(page);
  await sleep(500);
  await page.evaluate(() => { window.__stillHere = true; });
  tag = '"v2"';
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await sleep(2500);
  check("a new app version reloads the app by itself when nothing is in progress", !(await page.evaluate(() => window.__stillHere === true)));
  await page.waitForSelector("#main .row, #main .msg", { timeout: 8000 });
  check("after the update the board is back", await page.locator("#main .row").count() > 0);
});

// A flight not in the day's timetable reads CHECK MANUALLY (it may still fly); a
// flight landing far from the booked time still reads CHECK FLIGHT NO.
await scenario(async () => {
  const db = makeDb();
  Object.assign(db.bookings.find((x) => x.id === "b2"), { flight: "U22330", flight_note: "Not in the timetable · check the flight number" });
  Object.assign(db.bookings.find((x) => x.id === "b1"), { sched_time: "11:25", flight_status: "scheduled", flight_note: "Lands 11:25, over 6 h from the booked time · check the flight number" });
  const page = await phone(browser, db);
  await open(page); await page.waitForSelector('.row[data-id="b2"] .reg');
  const t2 = await page.textContent('.row[data-id="b2"]'), t1 = await page.textContent('.row[data-id="b1"]');
  check("not in the timetable: CHECK MANUALLY, no time made up", /CHECK MANUALLY/.test(t2) && !/CHECK FLIGHT NO/.test(t2), t2);
  check("far from the booked time: shows the flight's time and warns with the booked time", /11:25/.test(t1) && /CHECK FLIGHT · BOOKED \d\d:\d\d/.test(t1), t1);
});

// A car with several tags (CHECK FLIGHT NO., OVERSTAY, £ DUE) on a phone: every tag stays
// clear of the buttons (on 28 Sept they ran under SENT and hid the money due).
await scenario(async () => {
  const db = makeDb(), b3 = db.bookings.find((x) => x.id === "b3");
  db.company.overstay_rate = 30;
  Object.assign(db.bookings.find((x) => x.id === "b1"), { make: "VOLKSWAGEN GOLF", flight: "U22334", sched_time: "23:50", est_time: "00:12", flight_status: "landed", sent_at: iso(TONIGHT, "23:41"), sent_by: "s2" });
  Object.assign(b3, { flight: "TBC", overstay: true, called_word: "Called", called_at: iso(TONIGHT, "22:51"), sent_at: iso(TONIGHT, "22:58"), sent_by: "s2", return_at: iso(addDays(TONIGHT, -2), "23:00") });   // two days back: £ due whatever the time of day
  const page = await phone(browser, db, { width: 390 });
  await open(page); await page.waitForSelector('.row[data-id="b3"] .reg');
  const r = await page.evaluate(() => {
    const row = document.querySelector('.row[data-id="b3"]'), acts = row.querySelector(".acts").getBoundingClientRect();
    return [...row.querySelectorAll(".l2 .tag")].map((t) => { const b = t.getBoundingClientRect(); return { t: t.textContent, right: Math.round(b.right), acts: Math.round(acts.left) }; });
  });
  check("row tags: CHECK FLIGHT NO., OVERSTAY and £ DUE all shown", /CHECK FLIGHT/.test(JSON.stringify(r)) && /OVERSTAY/.test(JSON.stringify(r)) && /DUE/.test(JSON.stringify(r)), r);
  check("row tags: none runs under the buttons", r.length > 0 && r.every((x) => x.right <= x.acts), r);
  // An ordinary landed car keeps flight and times on one line (28 Sept: they wrapped).
  const one = await page.evaluate(() => {
    const row = document.querySelector('.row[data-id="b1"]'); if (!row) return null;
    const a = row.querySelector(".l2a").getBoundingClientRect(), b = row.querySelector(".l2b").getBoundingClientRect(), acts = row.querySelector(".acts").getBoundingClientRect();
    return { same: Math.abs(a.top - b.top) < 4, right: Math.round(b.right), acts: Math.round(acts.left), text: row.querySelector(".l2").textContent };
  });
  check("row: flight and landing times stay on one line, clear of the buttons", !!one && one.same && one.right <= one.acts && /LANDED/.test(one.text), one);
  await page.screenshot({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + "/row-tags.png" : "/dev/null", clip: { x: 0, y: 0, width: 390, height: 700 } }).catch(() => {});
});

// 18a. back in the app after a while (WhatsApp, a call): only what changed is
// fetched, not the whole sheet (the free plan's download allowance).
await scenario(async () => {
  const db = makeDb();
  const page = await phone(browser, db);
  await open(page);
  // Signal lost in the car park, then back a few minutes later.
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  // Meanwhile, on other phones: a note on b2, and b3 carried to tomorrow's sheet.
  const later = new Date(Date.now() + 5000).toISOString();
  Object.assign(db.bookings.find((x) => x.id === "b2"), { note: "CALLED BACK", updated_at: later });
  Object.assign(db.bookings.find((x) => x.id === "b3"), { sheet_id: "d1", updated_at: later });
  db.bookingGets = [];
  await sleep(500);
  await page.evaluate(() => window.dispatchEvent(new Event("online"))); await sleep(1500);
  const gets = db.bookingGets.filter((q) => q.sheet_id === "eq.d0" || (q.sheet_id || "").startsWith("neq."));
  check("signal back: the change made meanwhile shows", /CALLED BACK/.test(await text(page, '.row[data-id="b2"]')));
  check("signal back: a car moved to another sheet leaves this one", await page.locator('.row[data-id="b3"]').count() === 0);
  check("signal back: only the changes are fetched, not the whole sheet", gets.length > 0 && gets.every((q) => (q.updated_at || "").startsWith("gte.")), gets);
  check("signal back: no errors", page.__errors.length === 0, page.__errors);
});

// 18b. import on a phone: the file picker sends the app to the background; the
// file must still be taken when it comes back (it was lost to a redraw).
await scenario(async () => {
  const db = makeDb();
  const page = await phone(browser, db);
  await open(page);
  await page.click("#menuBtn"); await sleep(300); await page.click('#menu [data-view="import"]'); await sleep(300);
  const input = await page.$('input[data-file="excel"]');
  const vis = (state) => page.evaluate((st) => { Object.defineProperty(document, "visibilityState", { value: st, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); }, state);
  await vis("hidden"); await sleep(1500); await vis("visible");
  await input.setInputFiles({ name: "drops.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("x") });
  await sleep(400);
  check("import on a phone: the chosen file is taken after the file picker (app back from the background)", /drops\.xlsx/.test(await page.locator(".steps").innerText()) && await page.locator("[data-read]:not([disabled])").count() === 1);
});

// 18c. after an import: ✕ and Undo at the top of the "not in this file" box; Undo on the Import screen
await scenario(async () => {
  const db = makeDb();
  const page = await phone(browser, db, { width: 1000 });
  await open(page);
  const b64 = await page.evaluate(async (day) => {
    await new Promise((ok, no) => { const s = document.createElement("script"); s.src = "/vendor/xlsx-0.18.5.full.min.js"; s.onload = ok; s.onerror = no; document.head.appendChild(s); });
    const [y, m, d] = day.split("-").map(Number);
    const serial = (dd, h, mi) => (Date.UTC(y, m - 1, dd, h, mi) - Date.UTC(1899, 11, 30)) / 864e5;
    const ws = XLSX.utils.aoa_to_sheet([["Ref", "Name", "Vehicle", "Booking From", "Booking To"], ["X1", "ONE", "FORD FIESTA AB12CDE", 0, 0]]);
    ws.D2 = { t: "n", v: serial(d, 13, 20), z: "dd/mm/yyyy hh:mm" }; ws.E2 = { t: "n", v: serial(d + 3, 1, 0), z: "dd/mm/yyyy hh:mm" };
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "S");
    return XLSX.write(wb, { type: "base64", bookType: "xlsx" });
  }, TONIGHT);
  await page.click("#menuBtn"); await sleep(300); await page.click('#menu [data-view="import"]'); await sleep(300);
  await page.click('[data-impkind="picks"]'); await sleep(200);
  await page.setInputFiles('input[data-file="excel"]', { name: "picks.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(b64, "base64") });
  await sleep(200); await page.click("[data-read]"); await page.waitForSelector("[data-create]", { timeout: 8000 });
  await page.click("[data-create]"); await sleep(900);
  check("after import: the 'not in this file' box has a ✕ and Undo this import at the top", await page.locator("#panelBody .pclose").count() === 1 && await page.locator("#panelBody .pbtns.top [data-undoimport]").count() === 1);
  await page.click("#panelBody .pclose"); await sleep(300);
  check("after import: ✕ closes the box and removes nothing", !(await page.evaluate(() => document.getElementById("panel").open)) && !db.calls.some((c) => c.fn === "remove_booking"));
  await page.click("#menuBtn"); await sleep(300); await page.click('#menu [data-view="import"]'); await sleep(600);
  check("Import screen lists the import with an Undo button", await page.locator(".impundo [data-undoimport]").count() === 1, await page.locator(".impundo").innerText().catch(() => ""));
  await page.click(".impundo [data-undoimport]"); await sleep(800);
  check("Undo asks, then undoes that import on the server", db.calls.some((c) => c.fn === "undo_import" && c.args.p_id === 70) && /Import undone/.test(await toast(page)), await toast(page));
  check("undo: no errors", page.__errors.length === 0, page.__errors);
});

// 19. the office adds a car by hand; takes an overstay payment; removes a car and puts it back
await scenario(async () => {
  const db = makeDb(); db.company.overstay_rate = 30;
  db.bookings.find((x) => x.id === "b3").return_at = iso(addDays(TONIGHT, -3), "22:15");
  const page = await phone(browser, db, { width: 800 });
  await open(page);
  // Add a car: a time after midnight on the sheet's own date is the next morning.
  await page.click("#menuBtn"); await sleep(300); await page.click("#menu [data-addcar]"); await sleep(300);
  await page.fill("#acReg", "zz12 new");
  await page.click("#acGo"); await sleep(300);
  check("add a car: DROPS without a BACK time is refused", /date and the time/.test(await toast(page)) && !db.calls.some((c) => c.fn === "add_booking"));
  await page.fill("#acRetT", "0130"); await page.click("#acGo"); await sleep(600);
  const add = db.calls.find((c) => c.fn === "add_booking");
  check("add a car: 01:30 on the sheet's date is saved as the next morning", !!add && add.args.p.return_local === addDays(TONIGHT, 1) + " 01:30", add && add.args.p);
  // A car added to PICKS that comes back the same day: asked, then put on DROPS too.
  await page.selectOption("#sheetPick", "p0"); await sleep(600);
  await page.click("#menuBtn"); await sleep(300); await page.click("#menu [data-addcar]"); await sleep(300);
  await page.fill("#acReg", "ZZ28SDR"); await page.fill("#acName", "Same Day"); await page.fill("#acDropT", "0800");
  await page.fill("#acRetD", TONIGHT); await page.fill("#acRetT", "1900"); await page.click("#acGo"); await sleep(1200);
  const ask = page.__dialogs.find((m) => /ZZ28SDR/.test(m)) || "";
  check("same-day PICKS car: the app asks to add it to DROPS", /DROPS/.test(ask) && /Add this car/.test(ask), page.__dialogs);
  const tw = db.calls.find((c) => c.fn === "add_pick_to_drops");
  check("same-day PICKS car: said yes, it's added to DROPS", !!tw && db.bookings.some((x) => x.kind === "drops" && x.sheet_id === "d0" && x.reg === "ZZ28SDR"));
  await page.click("#menuBtn"); await sleep(300); await page.click("#menu [data-addcar]"); await sleep(300);
  await page.fill("#acReg", "ZZ28LTR"); await page.fill("#acDropT", "0900");
  await page.fill("#acRetD", addDays(TONIGHT, 5)); await page.fill("#acRetT", "1900"); await page.click("#acGo"); await sleep(1200);
  check("PICKS car back on a day with no DROPS sheet yet: not asked", !page.__dialogs.some((m) => /ZZ28LTR/.test(m)));
  await page.selectOption("#sheetPick", "d0"); await sleep(600);
  // A charge on a car that isn't an overstay (e.g. return date changed, £30).
  await page.click('.row[data-id="b1"] .reg'); await sleep(400);
  check("add charge: offered on a DROPS car with nothing due", await page.locator("[data-chargeadd]").count() === 1 && await page.locator(".chgbox").count() === 0);
  await page.click("[data-chargeadd]"); await sleep(300);
  await page.fill("#chgAmount", "30"); await page.fill("#chgReason", "return date changed"); await page.click('[data-chargeagreed="set"]'); await sleep(500);
  const ac = db.calls.filter((c) => c.fn === "set_overstay_agreed").pop();
  check("add charge: saves the amount and the reason", !!ac && ac.args.p_amount === 30 && ac.args.p_reason === "return date changed", ac && ac.args);
  const acBox = await page.locator(".chgbox").innerText().catch(() => "");
  check("add charge: the panel shows £30 due and why, with CASH / CARD / WAIVE", /£30 due/.test(acBox) && /return date changed/.test(acBox) && await page.locator('[data-charge="cash"]').count() === 1, acBox);
  if (await page.locator("#panel[open]").count()) await page.click("[data-close]").catch(() => {});
  await sleep(300);
  check("add charge: the row shows £30 DUE", /£30 DUE/.test(await text(page, '.row[data-id="b1"]')));
  // Overstay payment
  await page.click('.row[data-id="b3"] .reg'); await sleep(400);
  const due = await page.locator(".chgbox").innerText().catch(() => "");
  check("overstay: the panel shows what's due", /£\d+ due/.test(due), due);
  await page.fill("#chgAmount", "40"); await page.click('[data-chargeagreed="set"]'); await sleep(500);
  const agr = db.calls.find((c) => c.fn === "set_overstay_agreed" && c.args.p_booking === "b3");
  check("overstay: SET AS DUE saves the amount typed", !!agr && agr.args.p_amount === 40, agr && agr.args);
  const agreedBox = await page.locator(".chgbox").innerText().catch(() => "");
  check("overstay: the panel shows the agreed amount and what it was", /£40 due/.test(agreedBox) && /agreed · was £\d+/.test(agreedBox), agreedBox);
  check("overstay: the row shows the agreed amount due", /£40 DUE/.test(await text(page, '.row[data-id="b3"]')));
  await page.click('.chgbox [data-chargeagreed=""]'); await sleep(500);
  check("overstay: Undo puts back the daily-rate sum", db.calls.some((c) => c.fn === "set_overstay_agreed" && c.args.p_amount === null) && !/agreed/.test(await page.locator(".chgbox").innerText().catch(() => "")));
  await page.fill("#chgAmount", "85"); await page.click('[data-charge="cash"]'); await sleep(500);
  const pay = db.calls.find((c) => c.fn === "set_overstay_paid");
  check("overstay: CASH records the amount typed", !!pay && pay.args.p_amount === 85 && pay.args.p_method === "cash", pay && pay.args);
  if (await page.locator("#panel[open]").count()) await page.click("[data-close]").catch(() => {});
  await sleep(300);
  check("overstay: the row shows it paid", /£85 CASH/.test(await text(page, '.row[data-id="b3"]')));
  // Remove and put back
  await page.click('.row[data-id="b2"] .reg'); await sleep(400);
  await page.click("[data-removecar]"); await sleep(300);
  const reasonBtn = page.locator("[data-removewhy]").first();
  if (await reasonBtn.count()) { await reasonBtn.click(); await sleep(500); }
  check("remove: the car leaves the board", db.calls.some((c) => c.fn === "remove_booking") && await page.locator('.row[data-id="b2"]').count() === 0);
  await page.click("#menuBtn"); await sleep(300); await page.click("#menu [data-removedlist]"); await sleep(300);
  await page.click('[data-restore="b2"]'); await sleep(500);
  await page.click("[data-close]").catch(() => {}); await sleep(300);
  check("put back: the car is on the board again, once", await page.locator('.row[data-id="b2"]').count() === 1);
  // Customer rang: coming back another day
  await page.click('.row[data-id="b1"] .reg'); await sleep(400);
  check("return by hand: the panel shows the booked date and time", (await page.inputValue("#retD")) === TONIGHT && /^\d\d:\d\d$/.test(await page.inputValue("#retT")));
  await page.fill("#retD", addDays(TONIGHT, 2)); await page.fill("#retT", "2330"); await page.click("[data-savepanel]"); await sleep(600);
  const sr = db.calls.find((c) => c.fn === "set_return");
  check("return by hand: Save sends the new date and time", !!sr && sr.args.p_return_local === addDays(TONIGHT, 2) + " 23:30", sr && sr.args);
  check("return by hand: the row shows WAS and the first day", /WAS/.test(await text(page, '.row[data-id="b1"]')), await text(page, '.row[data-id="b1"]'));
  // Changed to tomorrow, whose sheet is already in: the car goes there and leaves tonight's board.
  await page.click('.row[data-id="b2"] .reg'); await sleep(400);
  await page.fill("#retD", TOMORROW); await page.fill("#retT", "1800"); await page.click("[data-savepanel]"); await sleep(800);
  check("return by hand to a day whose sheet is in: the car leaves tonight's board", await page.locator('.row[data-id="b2"]').count() === 0 && db.bookings.find((x) => x.id === "b2").sheet_id === "d1");
});

// 19b. the return flight given at drop-off: typed on the PICKS car (setup 78), every look
for (const theme of ["", "stdplus", "ops", "premium", "board"]) await scenario(async () => {
  const db = makeDb(); if (theme) db.company.brand = { theme, colour: "#F9A01B", ink: "#172536", short: "TakeOff" };
  db.me = { ...db.me, role: "terminal" }; db.perms = { clear: true, picksinfo: true, note: true, intake: true };
  const page = await phone(browser, db);
  const look = theme || "standard";
  await open(page); await pickKind(page, "picks");
  const top = await page.locator("#main .row").first().evaluate((e) => e.getBoundingClientRect().top);
  await page.click('.row[data-id="p1"] .reg'); await page.waitForSelector("#panel[open]");
  check("Return flight (" + look + "): the PICKS car has a Return flight box", await page.isVisible("#pickFlightText"));
  await page.fill("#pickFlightText", "ls 1234"); await page.click("[data-savepanel]"); await sleep(600);
  const c = db.calls.filter((x) => x.fn === "set_pick_flight").pop();
  check("Return flight (" + look + "): Save sends it, tidied", c && c.args.p_booking === "p1" && c.args.p_flight === "LS1234", c);
  check("Return flight (" + look + "): the row shows it after the drop time", /LS1234/.test(await text(page, '.row[data-id="p1"]')), await text(page, '.row[data-id="p1"]'));
  check("Return flight (" + look + "): the note is left alone", !db.calls.some((x) => x.fn === "set_note"));
  check("Return flight (" + look + "): the rows don't move", Math.abs(top - await page.locator("#main .row").first().evaluate((e) => e.getBoundingClientRect().top)) < 1);
  await page.click('.row[data-id="p1"] .reg'); await page.waitForSelector("#panel[open]");
  check("Return flight (" + look + "): the box shows the saved flight", await page.inputValue("#pickFlightText") === "LS1234");
  await page.fill("#pickFlightText", "LS1234"); await page.click("[data-savepanel]"); await sleep(400);
  check("Return flight (" + look + "): unchanged sends nothing", db.calls.filter((x) => x.fn === "set_pick_flight").length === 1);
});
await scenario(async () => {
  const db = makeDb(); db.me = { ...db.me, role: "view" }; db.perms = {};
  const page = await phone(browser, db);
  await open(page); await pickKind(page, "picks");
  await page.click('.row[data-id="p1"] .reg'); await page.waitForSelector("#panel[open]");
  check("Return flight: view-only has no box", !(await page.isVisible("#pickFlightText")));
});
// The office changes a PICKS car's return time (the customer rang), instead of a note.
for (const theme of ["", "ops"]) await scenario(async () => {
  const db = makeDb(); if (theme) db.company.brand = { theme, colour: "#F9A01B", ink: "#172536", short: "TakeOff" };
  const page = await phone(browser, db);
  const look = theme || "standard";
  await open(page); await pickKind(page, "picks");
  await page.click('.row[data-id="p1"] .reg'); await page.waitForSelector("#panel[open]");
  check("PICKS return (" + look + "): the office gets the return date and time boxes", await page.isVisible("#retD") && await page.isVisible("#retT"));
  check("PICKS return (" + look + "): they show the booked return", await page.inputValue("#retD") === addDays(TONIGHT, 1) && await page.inputValue("#retT") === new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" }).format(new Date(iso(addDays(TONIGHT, 1), "09:00"))), [await page.inputValue("#retD"), await page.inputValue("#retT")]);
  await page.fill("#retT", "0715"); await page.click("[data-savepanel]"); await sleep(600);
  const c = db.calls.filter((x) => x.fn === "set_pick_return").pop();
  check("PICKS return (" + look + "): Save sends the new time", c && c.args.p_booking === "p1" && c.args.p_return_local === addDays(TONIGHT, 1) + " 07:15", c);
  check("PICKS return (" + look + "): no note needed", !db.calls.some((x) => x.fn === "set_note" || x.fn === "set_return"));
  await page.click('.row[data-id="p1"] .reg'); await page.waitForSelector("#panel[open]");
  check("PICKS return (" + look + "): the car shows the new time", await page.inputValue("#retT") === "07:15" && /07:15/.test(await page.locator("#panelBody .det").innerText()));
});
await scenario(async () => {
  const db = makeDb(); db.me = { ...db.me, role: "terminal" }; db.perms = { clear: true, picksinfo: true, note: true, intake: true };
  const page = await phone(browser, db);
  await open(page); await pickKind(page, "picks");
  await page.click('.row[data-id="p1"] .reg'); await page.waitForSelector("#panel[open]");
  check("PICKS return: terminal staff don't get the boxes", !(await page.isVisible("#retD")));
});

// 20. a big night: 400 cars on one sheet stays quick
await scenario(async () => {
  const db = makeDb();
  for (let i = 0; i < 400; i++) {
    const h = 18 + Math.floor(i / 40), m = (i * 7) % 60;
    db.bookings.push({ id: "big" + i, company_id: "c1", sheet_id: "d0", kind: "drops", ref: "BIG" + i, reg: "BG" + String(i).padStart(2, "0") + "XYZ", num: 10 + i,
      name: "CUSTOMER " + i, make: "FORD", flight: "U2" + (2000 + i), return_at: iso(h < 24 ? TONIGHT : addDays(TONIGHT, 1), String(h % 24).padStart(2, "0") + ":" + String(m).padStart(2, "0")), note: i % 9 ? "" : "NOTE " + i, yard: ["NB", "S", ""][i % 3] });
  }
  const page = await phone(browser, db);
  let t0 = Date.now(); await open(page); await page.waitForSelector('.row[data-id="big399"]', { state: "attached" }); const tOpen = Date.now() - t0;
  const ms = await page.evaluate(async () => {
    const btn = document.querySelector('.row[data-id="big200"] [data-act="sent"]');
    const t = performance.now(); btn.click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return performance.now() - t;
  });
  t0 = Date.now(); await page.fill("#q", "BG25"); await page.waitForFunction(() => document.querySelectorAll("#main .row").length < 20); const tSearch = Date.now() - t0;
  console.log("      400 cars: open " + tOpen + " ms, SENT tap on screen " + Math.round(ms) + " ms, search " + tSearch + " ms");
  check("400 cars: the board opens in under 3 s", tOpen < 3000, tOpen);
  check("400 cars: a tap shows in under 250 ms", ms < 250, ms);
  check("400 cars: search answers in under 1.5 s", tSearch < 1500, tSearch);
  check("400 cars: no sideways scrolling", await noSideScroll(page));
});

// 21. small Android phone width
await scenario(async () => {
  const page = await phone(browser, makeDb(), { width: 360, ua: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36" });
  await open(page);
  check("360 px wide phone: no sideways scrolling on the board", await noSideScroll(page));
});


// ── stress tests (STRESS=1) ──────────────────────────────────────────────
// 2. A big night on a slow phone, 3. bad signal, 4. big imports.
function bigDb(drops, picks) {
  const db = makeDb();
  db.bookings = db.bookings.filter((b) => b.sheet_id !== "d0" && b.sheet_id !== "p0");
  for (let i = 0; i < drops; i++) {
    const mins = 6 * 60 + Math.floor(i * (23 * 60) / drops), day = mins < 24 * 60 ? TONIGHT : addDays(TONIGHT, 1), hm = String(Math.floor(mins / 60) % 24).padStart(2, "0") + ":" + String(mins % 60).padStart(2, "0");
    db.bookings.push({ id: "sd" + i, company_id: "c1", sheet_id: "d0", kind: "drops", ref: "SD" + i, reg: "SD" + String(i).padStart(3, "0") + "XY", num: i + 1, name: "CUSTOMER " + i,
      make: ["FORD", "KIA", "BMW", "AUDI"][i % 4], flight: "U2" + (3000 + i), return_at: iso(day, hm), yard: ["NB", "S", ""][i % 3], note: i % 25 ? "" : "S/D", updated_at: now() });
  }
  for (let i = 0; i < picks; i++) {
    const mins = 4 * 60 + Math.floor(i * (19 * 60) / picks), hm = String(Math.floor(mins / 60)).padStart(2, "0") + ":" + String(mins % 60).padStart(2, "0");
    db.bookings.push({ id: "sp" + i, company_id: "c1", sheet_id: "p0", kind: "picks", ref: "SP" + i, reg: "SP" + String(i).padStart(3, "0") + "XY", num: i + 1, name: "PICK " + i,
      drop_at: iso(TONIGHT, hm), return_at: iso(addDays(TONIGHT, 1 + (i % 9)), "10:00"), intake: "", note: "", updated_at: now() });
  }
  return db;
}
// No signal, for real: every request to the database fails until it's back.
async function noSignal(page) {
  const state = { off: false };
  await page.context().route("**/rest/v1/**", (route) => state.off ? route.abort("internetdisconnected") : route.fallback());
  return {
    off: async () => { state.off = true; await page.context().setOffline(true); await page.evaluate(() => window.dispatchEvent(new Event("offline"))); },
    on: async () => { state.off = false; await page.context().setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event("online"))); },
    state
  };
}
async function slowPhone(page, rate) { const cdp = await page.context().newCDPSession(page); await cdp.send("Emulation.setCPUThrottlingRate", { rate }); return cdp; }
async function stressTests() {
  // 2. 800 DROPS and 800 PICKS, phone four times slower than this computer
  for (const theme of ["", "stdplus"]) await scenario(async () => {
    const db = bigDb(800, 800); if (theme) db.company.brand = { ...db.company.brand, theme };
    const look = theme || "standard";
    const page = await phone(browser, db);
    await slowPhone(page, 4);
    let t0 = Date.now(); await page.goto(BASE + "/"); await page.waitForSelector('.row[data-id="sd799"]', { state: "attached", timeout: 30000 }); const tOpen = Date.now() - t0;
    if (process.env.PROFILE) {
      const cdp2 = await page.context().newCDPSession(page); await cdp2.send("Profiler.enable"); await cdp2.send("Profiler.setSamplingInterval", { interval: 100 }); await cdp2.send("Profiler.start");
      await page.evaluate(async () => { document.querySelector('.row[data-id="sd401"] [data-act="sent"]').click(); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); });
      const { profile } = await cdp2.send("Profiler.stop");
      const self = {}; const byId = Object.fromEntries(profile.nodes.map((n) => [n.id, n]));
      const dt = profile.timeDeltas; profile.samples.forEach((id, i) => { const n = byId[id]; const k = (n.callFrame.functionName || "(anon)") + ":" + n.callFrame.lineNumber; self[k] = (self[k] || 0) + (dt[i] || 0); });
      console.log(Object.entries(self).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => k + " " + Math.round(v / 1000) + "ms").join("\n"));
    }
    const tTap = await page.evaluate(async () => { const b = document.querySelector('.row[data-id="sd400"] [data-act="sent"]'); const t = performance.now(); b.click(); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return performance.now() - t; });
    const tScroll = await page.evaluate(async () => { const t = performance.now(); window.scrollTo(0, document.body.scrollHeight); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); window.scrollTo(0, 0); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return performance.now() - t; });
    t0 = Date.now(); await page.fill("#q", "SD42"); await page.waitForFunction(() => document.querySelectorAll("#main .row").length < 20, null, { timeout: 15000 }); const tSearch = Date.now() - t0;
    await page.fill("#q", ""); await sleep(300);
    const todo = await page.textContent("#tabTodo");
    t0 = Date.now();
    if (await page.locator("#kindSeg:not(.hidden)").count()) await page.click("#kindSeg [data-kind=picks]"); else await page.selectOption("#sheetPick", "p0");
    await page.waitForSelector('.row[data-id="sp799"]', { state: "attached", timeout: 30000 }); const tPicks = Date.now() - t0;
    const tPick = await page.evaluate(async () => { const b = document.querySelector('.row[data-id="sp300"] [data-pick="Collected"]'); const t = performance.now(); b.click(); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return performance.now() - t; });
    console.log("      " + look + ", 800 + 800 cars, phone 4x slower: open " + tOpen + " ms, tap " + Math.round(tTap) + " ms, scroll end-to-end " + Math.round(tScroll) + " ms, search " + tSearch + " ms, to PICKS " + tPicks + " ms, COLL " + Math.round(tPick) + " ms");
    check("Stress (" + look + "): 800 DROPS open in under 8 s on a slow phone", tOpen < 8000, tOpen);
    check("Stress (" + look + "): a SENT tap shows in under 500 ms", tTap < 500, tTap);
    check("Stress (" + look + "): scrolling to the end and back stays under 1 s", tScroll < 1000, tScroll);
    check("Stress (" + look + "): search answers in under 3 s", tSearch < 3000, tSearch);
    check("Stress (" + look + "): switching to 800 PICKS takes under 6 s", tPicks < 6000, tPicks);
    check("Stress (" + look + "): a COLL tap shows in under 500 ms", tPick < 500, tPick);
    check("Stress (" + look + "): TO DO still counts right (799 not sent)", /799/.test(todo), todo);
    const sent = db.calls.filter((c) => c.fn === "tap_drop");
    check("Stress (" + look + "): the tap reached the server once", sent.length === 1 && sent[0].args.p_booking === "sd400", sent.map((c) => c.args));
    check("Stress (" + look + "): no sideways scrolling with 800 cars", await noSideScroll(page));
  });

  // 3a. No signal: 10 taps (one undone), then the signal comes back.
  await scenario(async () => {
    const db = bigDb(40, 0);
    const page = await phone(browser, db);
    const net = await noSignal(page);
    await open(page); await page.waitForSelector('.row[data-id="sd9"]');
    await net.off();
    for (let i = 0; i < 10; i++) { await page.click('.row[data-id="sd' + i + '"] [data-act="sent"]'); await sleep(120); }
    await page.click('.row[data-id="sd3"] [data-act="sent"]'); await sleep(200);
    const shown = await page.evaluate(() => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => document.querySelector('.row[data-id="sd' + i + '"] [data-act="sent"]').classList.contains("on")));
    check("Stress, no signal: every tap shows at once on the phone", shown.filter(Boolean).length === 9 && !shown[3], shown);
    check("Stress, no signal: nothing reached the server yet", !db.calls.some((c) => c.fn === "tap_drop"));
    await net.on();
    await page.waitForFunction(() => !document.querySelector(".row.busy"), null, { timeout: 20000 }).catch(() => {}); await sleep(1500);
    const taps = db.calls.filter((c) => c.fn === "tap_drop").map((c) => c.args.p_booking + (c.args.p_on ? "+" : "-"));
    const per = (id) => taps.filter((t) => t.startsWith(id + "+") || t.startsWith(id + "-"));
    check("Stress, signal back: each car saved exactly once", [0, 1, 2, 4, 5, 6, 7, 8, 9].every((i) => per("sd" + i).length === 1 && per("sd" + i)[0].endsWith("+")), taps);
    check("Stress, signal back: the undone car saved on then off, in that order", per("sd3").join(",") === "sd3+,sd3-", per("sd3"));
    check("Stress, signal back: the server matches the phone", [0, 1, 2, 4, 5, 6, 7, 8, 9].every((i) => db.bookings.find((b) => b.id === "sd" + i).sent_at) && !db.bookings.find((b) => b.id === "sd3").sent_at);
  });

  // 3b. Taps made with no signal survive the app being closed and opened again.
  await scenario(async () => {
    const db = bigDb(20, 0);
    const page = await phone(browser, db);
    const net = await noSignal(page);
    await open(page); await page.waitForSelector('.row[data-id="sd5"]');
    await net.off();
    for (let i = 0; i < 5; i++) { await page.click('.row[data-id="sd' + i + '"] [data-act="sent"]'); await sleep(120); }
    const queued = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("takeoff_queue_")).map((k) => JSON.parse(localStorage.getItem(k)).length).reduce((a, b) => a + b, 0));
    check("Stress, app closed with no signal: the 5 taps are kept on the phone", queued === 5, queued);
    // Opened again while the database still can't be reached, then the signal comes back.
    await page.context().setOffline(false); await page.reload(); await sleep(2500);
    const early = db.calls.filter((c) => c.fn === "tap_drop").length;
    await net.on(); await page.waitForSelector('.row[data-id="sd5"]', { timeout: 15000 }).catch(() => {}); await sleep(3000);
    check("Stress, app opened again before the signal: nothing lost, nothing sent early", early === 0, early);
    const taps = db.calls.filter((c) => c.fn === "tap_drop").map((c) => c.args.p_booking);
    check("Stress, app opened again: the 5 taps are saved, once each", taps.length === 5 && new Set(taps).size === 5, taps);
  });

  // 3c. Weak signal: every save takes 2.5 s; 8 quick taps.
  await scenario(async () => {
    const db = bigDb(20, 0);
    const page = await phone(browser, db);
    await page.route("**/rest/v1/rpc/tap_drop", async (route) => { await sleep(2500); await route.fallback(); });
    await open(page); await page.waitForSelector('.row[data-id="sd8"]');
    const t0 = Date.now();
    for (let i = 0; i < 8; i++) await page.click('.row[data-id="sd' + i + '"] [data-act="sent"]');
    const tapsMs = Date.now() - t0;
    const allOn = await page.evaluate(() => [0, 1, 2, 3, 4, 5, 6, 7].every((i) => document.querySelector('.row[data-id="sd' + i + '"] [data-act="sent"]').classList.contains("on")));
    check("Stress, weak signal: 8 taps don't wait for each other (" + tapsMs + " ms)", tapsMs < 4000 && allOn, { tapsMs, allOn });
    await page.waitForFunction(() => !document.querySelector(".row.busy"), null, { timeout: 40000 }).catch(() => {}); await sleep(500);
    const taps = db.calls.filter((c) => c.fn === "tap_drop").map((c) => c.args.p_booking);
    check("Stress, weak signal: all 8 saved, none twice", taps.length === 8 && new Set(taps).size === 8, taps);
  });

  // 3d. Dropping signal: the first try of every save is cut off.
  await scenario(async () => {
    const db = bigDb(20, 0);
    const page = await phone(browser, db);
    const tried = {};
    await page.route("**/rest/v1/rpc/tap_drop", async (route) => {
      const k = (route.request().postData() || "");
      if (!tried[k]) { tried[k] = 1; return route.abort("connectionreset"); }
      return route.fallback();
    });
    await open(page); await page.waitForSelector('.row[data-id="sd6"]');
    for (let i = 0; i < 6; i++) { await page.click('.row[data-id="sd' + i + '"] [data-act="sent"]'); await sleep(100); }
    await page.waitForFunction(() => !document.querySelector(".row.busy"), null, { timeout: 60000 }).catch(() => {}); await sleep(1000);
    const taps = db.calls.filter((c) => c.fn === "tap_drop").map((c) => c.args.p_booking);
    check("Stress, signal dropping: every tap still saved, once each", taps.length === 6 && new Set(taps).size === 6, taps);
    check("Stress, signal dropping: the phone shows all 6 as SENT", await page.evaluate(() => [0, 1, 2, 3, 4, 5].every((i) => document.querySelector('.row[data-id="sd' + i + '"] [data-act="sent"]').classList.contains("on"))));
  });

  // 4. Big imports: a 500-car file, read and sent, then the same file again.
  for (const kind of ["drops", "picks"]) await scenario(async () => {
    const db = makeDb();
    const page = await phone(browser, db, { width: 1000 });
    await open(page);
    const d1 = addDays(TONIGHT, 1);
    const rows = [" Reference Number \t Car Reg \t Client \t Booking From \t Drop off Time \t Booking To \t Collection Time "];
    for (let i = 1; i <= 500; i++) {
      const m = 6 * 60 + Math.floor(i * (17 * 60) / 500), t = String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
      rows.push(["R" + i, "AB" + String(i).padStart(3, "0") + "CDE", "CUSTOMER " + i, kind === "picks" ? TONIGHT : addDays(TONIGHT, -3), kind === "picks" ? t : "08:00", kind === "picks" ? addDays(d1, i % 9) : TONIGHT, kind === "picks" ? "10:00" : t].join("\t"));
    }
    const file = { name: kind + "-500.xls", mimeType: "application/vnd.ms-excel", buffer: Buffer.from(rows.join("\n")) };
    const importOnce = async () => {
      for (let k = 0; k < 3; k++) { if (await page.evaluate(() => !!document.querySelector("dialog[open]"))) { await page.keyboard.press("Escape"); await sleep(300); } }
      await page.evaluate(() => document.getElementById("menuBtn").click()); await sleep(300); await page.click('#menu [data-view="import"]'); await sleep(300);
      await page.click('[data-impkind="' + kind + '"]'); await sleep(200);
      await page.setInputFiles('input[data-file="excel"]', file);
      const t0 = Date.now(); await sleep(100); await page.click("[data-read]"); await page.waitForSelector("[data-create]", { timeout: 30000 }); const tRead = Date.now() - t0;
      const n0 = db.calls.filter((c) => c.fn === "import_sheet").length;
      await page.click("[data-create]"); await page.waitForFunction((n) => true, n0); await sleep(1500);
      return { tRead, call: db.calls.filter((c) => c.fn === "import_sheet")[n0] };
    };
    const a = await importOnce();
    const sentRows = a.call ? a.call.args.p_rows.length : 0;
    let all = a.call ? a.call.args.p_rows : [];
    if (a.call && !a.call.args.p_rows.length) all = [];
    const days = new Set(db.calls.filter((c) => c.fn === "import_sheet").map((c) => c.args.p_day));
    const total = db.calls.filter((c) => c.fn === "import_sheet").reduce((t, c) => t + c.args.p_rows.length, 0);
    const refs = db.calls.filter((c) => c.fn === "import_sheet").flatMap((c) => c.args.p_rows.map((r) => r.ref));
    console.log("      " + kind + ": 500-row file read in " + a.tRead + " ms, sent as " + days.size + " day(s), " + total + " rows");
    check("Stress import (" + kind + "): 500 rows read in under 5 s", a.tRead < 5000, a.tRead);
    check("Stress import (" + kind + "): all 500 cars sent, none twice", total === 500 && new Set(refs).size === 500, { total, unique: new Set(refs).size, first: sentRows });
    const b = await importOnce();
    const total2 = db.calls.filter((c) => c.fn === "import_sheet").reduce((t, c) => t + c.args.p_rows.length, 0) - total;
    check("Stress import (" + kind + "): the same file again sends the same 500 (the server keeps one of each)", total2 === 500, total2);
  });
}

check("the security policy blocked nothing the app needs", cspBlocked.length === 0, cspBlocked.slice(0, 3));
await browser.close(); server.close();
console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);

// ── previews (SHOTS=dir) ─────────────────────────────────────────────────
async function shots(dir) {
  fs.mkdirSync(dir, { recursive: true });
  // SHOTS_ONLY=exit: the exit fee on Airport Parking Bay's look (part 76).
  if (process.env.SHOTS_ONLY === "exit") {
    // apbDb is defined after the SHOTS exit, so it's built here.
    const apbDb = (theme) => { const d = makeDb(); d.company = { ...d.company, name: "Airport Parking Bay", slug: "airport-parking-bay", yards: ["GS", "MY", "T"],
      brand: { colour: "#1560BD", ink: "#FFFFFF", soft: "#E8F0FB", text: "#0E3F7E", short: "Parking Bay", theme, chrome: "#0E3F7E", mark: "P" } }; return d; };
    const db = apbDb(process.env.SHOTS_THEME || "premium"); db.company.exit_fee = 10; db.company.exit_free = ["CAP", "APD", "VIPAPB1147"];
    db.bookings.find((x) => x.id === "b1").ref = "CAP-18-554625"; db.bookings.find((x) => x.id === "b2").ref = "CPD-19-612731"; db.bookings.find((x) => x.id === "b3").ref = "FHR-1427016249";
    Object.assign(db.bookings.find((x) => x.id === "b3"), { exit_method: "cash", exit_amount: 10, exit_at: new Date().toISOString(), exit_by: "s2", exit_photo: "c1/docs/b3/x1.jpg" });
    const page = await phone(browser, db, { width: 390 });
    await page.route("**/object/sign/pt-photos/**", (route) => /token=t/.test(route.request().url()) ? route.fulfill({ path: path.join(ROOT, "icons/icon-512.png"), contentType: "image/png" }) : route.fallback());
    const snap = async (name) => { await sleep(400); await page.screenshot({ path: path.join(dir, name + ".png"), fullPage: true }); };
    await open(page); await snap("exit-drops");
    const car = async (id, name) => { await page.click('.row[data-id="' + id + '"] .reg'); await sleep(500); await page.locator("#panelBody .exitbox, #panelBody .det").last().scrollIntoViewIfNeeded(); await sleep(300); await page.screenshot({ path: path.join(dir, name + ".png") }); await page.keyboard.press("Escape"); await sleep(200); };
    await car("b2", "exit-car-due"); await car("b3", "exit-car-paid"); await car("b1", "exit-car-free");
    await page.click("#bnav [data-bn=menuBtn]"); await sleep(300); await page.click('#menuBody [data-view="settings"]'); await sleep(400);
    await page.locator("[data-saveexit]").scrollIntoViewIfNeeded(); await sleep(300); await page.screenshot({ path: path.join(dir, "exit-settings.png") });
    await page.context().close();
    return;
  }
  // SHOTS_ONLY=flight: the return flight typed on a PICKS car (part 78), TakeOff's look.
  if (process.env.SHOTS_ONLY === "flight") {
    const db = makeDb(); db.company.brand = { colour: "#F9A01B", ink: "#1A1A1A", short: "TakeOff", theme: process.env.SHOTS_THEME || "stdplus" };
    const page = await phone(browser, db, { width: 390 });
    const snap = async (name) => { await sleep(400); await page.screenshot({ path: path.join(dir, name + ".png") }); };
    await open(page); await pickKind(page, "picks");
    await page.click('.row[data-id="p1"] .reg'); await sleep(500); await page.fill("#pickFlightText", "LS1234");
    await page.locator("#pickFlightText").scrollIntoViewIfNeeded(); await snap("flight-picks-car");
    await page.click("[data-savepanel]"); await sleep(600); await snap("flight-picks-row");
    await page.context().close();
    return;
  }
  // SHOTS_ONLY=yards: yard colours on Airport Parking Bay's look (part 77).
  if (process.env.SHOTS_ONLY === "yards") {
    const d = makeDb(); d.company = { ...d.company, name: "Airport Parking Bay", slug: "airport-parking-bay", yards: ["GS", "MY", "T"], yard_colours: { MY: "#2E7D32", GS: "#EF6C00", T: "#FBC02D" },
      brand: { colour: "#1560BD", ink: "#FFFFFF", soft: "#E8F0FB", text: "#0E3F7E", short: "Parking Bay", theme: process.env.SHOTS_THEME || "ops", chrome: "#0E3F7E", mark: "P", picks_yard: true } };
    const ys = ["MY", "GS", "T", "MY", "GS", "MY"];
    d.bookings.filter((x) => x.kind === "drops").forEach((x, i) => { x.yard = ys[i % ys.length]; });
    d.bookings.filter((x) => x.kind === "picks").forEach((x, i) => { if (i < 4) { x.intake = "Collected"; x.yard = ys[i]; } });
    const page = await phone(browser, d, { width: 390 });
    const snap = async (name) => { await sleep(400); await page.screenshot({ path: path.join(dir, name + ".png") }); };
    await open(page); await snap("yards-drops");
    await page.click('.row[data-id="b1"] .reg'); await sleep(500); await page.locator("#panelBody [data-setyard]").first().scrollIntoViewIfNeeded(); await snap("yards-car");
    await page.click("#panelBody [data-close]"); await sleep(300);
    if (await page.locator("#kindBar [data-kind=picks]:visible").count()) await page.click("#kindBar [data-kind=picks]"); else if (await page.locator("#kindSeg:not(.hidden)").count()) await page.click("#kindSeg [data-kind=picks]"); else await page.selectOption("#sheetPick", "p0");
    await snap("yards-picks");
    await page.click("#bnav [data-bn=menuBtn]"); await sleep(300); await page.click('#menuBody [data-view="settings"]'); await sleep(400);
    await page.locator("[data-saveycol]").scrollIntoViewIfNeeded(); await snap("yards-settings");
    await page.context().close();
    return;
  }
  const toDb = () => { const db = makeDb(); db.company.brand = { colour: "#F9A01B", ink: "#1A1A1A", short: "TakeOff", theme: process.env.SHOTS_THEME || "ops" }; db.bookings.find((b) => b.id === "p3").intake = "Collected"; return db; };
  for (const width of [390, 1280]) {
    const page = await phone(browser, toDb(), { width });
    await page.setViewportSize({ width, height: width > 600 ? 900 : 844 });
    const snap = async (name) => { await sleep(350); await page.screenshot({ path: path.join(dir, name + "-" + width + ".png"), fullPage: true }); };
    await open(page); await snap("drops");
    await pickKind(page, "picks"); await snap("picks");
    await pickKind(page, "drops");
    await page.click('#bnav [data-bn="menuBtn"]'); await sleep(300); await page.screenshot({ path: path.join(dir, "menu-board-" + width + ".png") }); await page.click('#bnav [data-bn="menuBtn"]', { force: true }).catch(() => {}); await page.keyboard.press("Escape"); await sleep(200);
    await page.locator("#main .row .reg").first().click(); await sleep(300); await page.screenshot({ path: path.join(dir, "car-" + width + ".png") }); await page.keyboard.press("Escape"); await sleep(200);
    for (const [bn, name] of [["logBtn", "summary"], ["flBtn", "flights"], ["psBtn", "stats"]]) { await page.click('#bnav [data-bn="' + bn + '"]'); await snap(name); await page.keyboard.press("Escape"); await sleep(150); }
    await page.click('#bnav [data-bn="menuBtn"]'); await sleep(300); await page.screenshot({ path: path.join(dir, "menu-" + width + ".png") });
    for (const v of ["settings", "staff", "dashboard"]) { if (!(await page.locator("#menu").evaluate((m) => m.open))) await page.click('#bnav [data-bn="menuBtn"]'); await sleep(200); await page.click('#menuBody [data-view="' + v + '"]'); await snap(v); if (v === "staff" && (await page.locator("#main .ops-dd summary").count())) { await page.click("#main .ops-dd summary"); await page.screenshot({ path: path.join(dir, "staff-actions-" + width + ".png") }); await page.keyboard.press("Escape"); } }
    // EARLY RETURN from a PICKS car (part 74), then the car on tonight's DROPS.
    await open(page); await pickKind(page, "picks");
    await page.click('.row[data-id="p3"] .reg'); await sleep(300);
    const night = addDays(TONIGHT, 3); await page.locator("#earlyDay").fill(night); await page.locator("#earlyDay").dispatchEvent("change"); await sleep(200);
    await page.locator("#earlyTo").scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(dir, "picks-early-" + width + ".png") });
    await page.click("[data-pearly]"); await sleep(1500); await snap("drops-early");
    await page.context().close();
  }
}
