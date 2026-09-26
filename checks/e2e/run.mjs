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
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json" };
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
    company: { id: "c1", name: "TAKEOFF", slug: "takeoff", yards: ["NB", "S"], drops_day_end: "06:00:00", brand: {}, time_zone: "Europe/London", pt_whatsapp: "447900000000", pt_method: opts.ptMethod || "photos", pt_copy_store: opts.ptStore || "supabase", overstay_rate: 0 },
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
  switch (fn) {
    case "me": return db.me;
    case "my_permissions": return Object.fromEntries(["sent", "called", "clear", "yard", "summary", "log", "flights", "rtc", "picksinfo", "import", "staff", "settings", "note", "intake"].map((k) => [k, true]));
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
    case "import_sheet": { const sh = db.sheets.find((x) => x.kind === a.p_kind && x.day === a.p_day); return { sheet_id: sh ? sh.id : "p0", added: a.p_rows.length, updated: 0, early: 0, moved: 0, new_marked: 0 }; }
    case "add_booking": { const n = { id: "new" + db.bookings.length, company_id: "c1", sheet_id: a.p_sheet, kind: db.sheets.find((x) => x.id === a.p_sheet).kind, ref: a.p.ref || "", reg: String(a.p.reg).toUpperCase(), name: a.p.name || "", num: 99, return_at: a.p.return_local ? new Date(a.p.return_local.replace(" ", "T") + ":00+01:00").toISOString() : null, note: a.p.note || "" }; db.bookings.push(n); return n; }
    case "set_overstay_paid": { const b = row(a.p_booking); Object.assign(b, { charge_amount: a.p_amount, charge_method: a.p_method, charge_at: a.p_method ? new Date().toISOString() : null, charge_by: a.p_method ? "s1" : null }); return b; }
    case "remove_booking": { const b = row(a.p_booking); Object.assign(b, { removed_at: new Date().toISOString(), removed_reason: a.p_reason, removed_by: "s1" }); return b; }
    case "restore_booking": { const b = db.bookings.find((x) => x.id === a.p_booking); Object.assign(b, { removed_at: null, removed_reason: "" }); return b; }
    case "set_reg": { const b = row(a.p_booking); b.reg = a.p_reg; return b; }
    case "set_yard": { const b = row(a.p_booking); b.yard = a.p_yard; return b; }
    case "set_flight": { const b = row(a.p_booking); b.flight = a.p_flight; return b; }
    case "set_sched_time": { const b = row(a.p_booking); b.sched_time = a.p_time; return b; }
    case "early_return": { const b = row(a.p_booking); b.moved_from = b.sheet_id; b.sheet_id = "d0"; b.early = true; b.early_at = now(); b.num = 105; return b; }
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
    if (p.startsWith("/storage/v1/object/pt-photos/")) { db.uploads.push(p.slice(29)); (db.uploadMarks = db.uploadMarks || []).push(((req.postDataBuffer() || Buffer.alloc(0)).toString("latin1").match(/name="cacheControl"\r\n\r\n(\d+)/) || [])[1] || ""); return reply(200, { Key: "pt-photos/" + p.slice(29) }); }
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
    if (p === "/rest/v1/staff") return reply(200, db.staff);
    if (p === "/rest/v1/sheets") return reply(200, db.sheets);
    if (p === "/rest/v1/bookings") {
      let rows = db.bookings.filter((b) => !b.removed_at);
      if (q.sheet_id && q.sheet_id.startsWith("eq.")) rows = rows.filter((b) => b.sheet_id === q.sheet_id.slice(3));
      if (q.sheet_id && q.sheet_id.startsWith("neq.")) rows = rows.filter((b) => b.sheet_id !== q.sheet_id.slice(4));
      if (q.id && q.id.startsWith("eq.")) rows = rows.filter((b) => b.id === q.id.slice(3));
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
async function phone(browser, db, { signedIn = true, ua, width = 390, noBitmap = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 844 }, userAgent: ua, permissions: ["camera"] });
  await backend(ctx, db);
  await ctx.addInitScript(([jwt, signedIn, noBitmap]) => {
    if (signedIn && !sessionStorage.getItem("seeded")) {
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("takeoff_link", "x".repeat(40));
      localStorage.setItem("sb-oioqjfrlwrjovnouhusp-auth-token", JSON.stringify({ access_token: jwt, refresh_token: "r", expires_at: 4102444800, expires_in: 3600, token_type: "bearer", user: { id: "u1" } }));
    }
    window.__shares = [];
    navigator.canShare = () => true;
    navigator.share = async (d) => { window.__shares.push({ n: (d.files || []).length, names: (d.files || []).map((f) => f.name), types: (d.files || []).map((f) => f.type), text: d.text || "" }); };
    try { navigator.clipboard.writeText = async () => {}; } catch (e) {}
    // Like an iPhone that won't decode a photo this way.
    if (noBitmap) window.createImageBitmap = () => Promise.reject(new Error("not supported"));
  }, [JWT, signedIn, noBitmap]);
  const page = await ctx.newPage();
  page.setDefaultTimeout(6000);
  page.__errors = [];
  page.on("pageerror", (e) => page.__errors.push(e.message));
  page.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) cspBlocked.push(m.text()); });
  page.on("dialog", (d) => d.accept());
  ctx.on("page", (p) => { if (p !== page) p.close().catch(() => {}); });
  return page;
}
const open = async (page) => { await page.goto(BASE + "/"); await page.waitForSelector("#main .row, #main .msg", { timeout: 8000 }); };
const text = (page, sel) => page.locator(sel).first().innerText().catch(() => "");
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const toast = (page) => page.evaluate(() => [...document.querySelectorAll(".toast")].map((t) => t.textContent).join(" | "));

// Each section stands alone: if one breaks part-way, it's reported and the rest still run.
async function scenario(fn) {
  try { await fn(); } catch (e) {
    const at = (String(e.stack || "").match(/run\.mjs:(\d+)/) || [])[1];
    check("section finished without crashing", false, String(e.message || e).split("\n")[0] + (at ? " (run.mjs line " + at + ")" : ""));
  }
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });

// 1. first open, sign-in states
await scenario(async () => {
  const page = await phone(browser, makeDb(), { signedIn: false });
  await page.goto(BASE + "/"); await sleep(800);
  check("no personal link: shows the 'ask for your link' screen", await page.isVisible("#noLink"));
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
  const db = makeDb({ ptMethod: method, ptStore: opts.store }), page = await phone(browser, db, opts);
  await open(page);
  await page.selectOption("#sheetPick", "p0"); await sleep(700);
  await page.click('.row[data-id="p1"] [data-pt]');
  await page.waitForFunction(() => document.getElementById("camVideo") && document.getElementById("camVideo").videoWidth > 0, null, { timeout: 8000 });
  for (let i = 0; i < shots; i++) await page.click("[data-shutter]");
  await sleep(500); await page.click("[data-camdone]"); await sleep(1500);
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
  check("PT (R2): copies are small JPEGs", puts.every((x) => x.type === "image/jpeg" && x.size > 0 && x.size < 120000), puts.map((x) => x.size));
  const l = db.ptLinks[0] || { paths: [] };
  check("PT (R2): saved as one set of 12, each marked r2:", db.ptLinks.length === 1 && l.paths.length === 12 && l.paths.every((x) => /^r2:c1\/p1\/[A-Za-z0-9_-]+\/\d\d\.jpg$/.test(x)), l.paths);
  check("PT (R2): the browser's security rules let the uploads through", !cspBlocked.length, cspBlocked);
  check("PT (R2): no errors", page.__errors.length === 0, page.__errors);
  // The car's panel lists the set.
  await page.click('.row[data-id="p1"] .reg'); await sleep(800);
  check("PT (R2): the car's panel shows the 12 photos", /12 photos/.test(await text(page, "#ptPhotos")), await text(page, "#ptPhotos"));
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
// Cloudflare's side down: PT itself is untouched, nothing crashes.
await scenario(async () => {
  const { db, page } = await ptRun("photos", 3, { store: "r2" });
  db.r2Down = true;
  await page.click("[data-ptreg]"); await sleep(700);
  await page.click("[data-ptshare]"); await sleep(2500);
  check("PT (R2 down): sharing and the PT tick still work", (await page.evaluate(() => window.__shares.length)) >= 1 && db.calls.some((c) => c.fn === "tap_pick" && c.args.p_key === "pt"));
  check("PT (R2 down): no copies saved, no errors", db.ptLinks.length === 0 && !(db.r2Puts || []).length && page.__errors.length === 0, page.__errors);
});
await scenario(async () => {
  const { db, page } = await ptRun("pdf", 8);
  await page.waitForSelector("[data-ptpdf]:not([disabled])", { timeout: 8000 });
  check("PT (PDF): only the PDF button is offered", await page.locator("[data-ptreg]").count() === 0);
  await page.click("[data-ptpdf]"); await sleep(800);
  const sh = await page.evaluate(() => window.__shares);
  check("PT (PDF): one share, one PDF named after the reg, reg as the message", sh.length === 1 && sh[0].n === 1 && sh[0].types[0] === "application/pdf" && /^DY16MYO-PT-8-photos\.pdf$/.test(sh[0].names[0]) && sh[0].text === "DY16MYO", sh);
  check("PT (PDF): PT gets ticked", db.calls.some((c) => c.fn === "tap_pick" && c.args.p_key === "pt"));
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
  const opts = await page.locator("[data-ptmethod] option").allInnerTexts();
  check("Settings offers the three PT ways", opts.length === 3 && /PDF/.test(opts.join()) && /link/.test(opts.join()), opts);
  await page.selectOption("[data-ptmethod]", "pdf"); await sleep(500);
  check("choosing PDF saves it", db.company.pt_method === "pdf" && db.calls.some((c) => c.fn === "set_pt_method"));
  check("no sideways scrolling in Settings", await noSideScroll(page));
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
  const row1 = await page.locator('.row[data-id="b1"]').innerText();
  check("changed return shows WAS and the day first booked", new RegExp("WAS " + String(+addDays(TONIGHT, -3).slice(8, 10)).padStart(2, "0")).test(row1));
  check("changed return is charged from the first date", /£\d+ DUE/.test(row1));
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
  // Overstay payment
  await page.click('.row[data-id="b3"] .reg'); await sleep(400);
  const due = await page.locator(".chgbox").innerText().catch(() => "");
  check("overstay: the panel shows what's due", /£\d+ due/.test(due), due);
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

check("the security policy blocked nothing the app needs", cspBlocked.length === 0, cspBlocked.slice(0, 3));
await browser.close(); server.close();
console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
