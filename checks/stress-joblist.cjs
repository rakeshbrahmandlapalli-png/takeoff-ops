// Stress check for Airport Parking Bay's Joblist PDF reader: a made-up 6-page,
// 300-booking PICKS list (no real customers), drawn line by line the way the
// real PDF is (VIP references split over two lines, long names wrapped), read
// by the SHIPPING public/reader.js. Every booking must come out once, intact.
//   node checks/stress-joblist.cjs        (no installs needed)
const fs = require("fs"), path = require("path"), vm = require("vm");
const win = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "public", "reader.js"), "utf8"), {
  window: win, console, Promise, Math, String, Number, Date, RegExp, Object, Array, JSON,
  document: { querySelector: () => null, head: { appendChild() {} }, createElement: () => ({}) },
});
const R = win.TakeoffReader;
let failed = 0;
const ok = (n, c, d) => { console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(d)).slice(0, 300))); if (!c) failed++; };

// Column x positions, as on the 2026 sheets.
const X = { ref: 28, name: 110, phone: 200, meet: 270, ret: 330, reg: 395, make: 450, colour: 520, pt: 570, location: 600, note: 640 };
const head = (y) => ({ y, items: [["ID", "ref"], ["Customer", "name"], ["Mobile No", "phone"], ["Departure Date", "meet"], ["Return Date", "ret"], ["Vehicle Reg", "reg"], ["Make & Model", "make"], ["Colour", "colour"], ["PT", "pt"], ["Location", "location"], ["Notes", "note"]].map(([s, k]) => ({ x: X[k], w: 30, s })) });
const pad = (n) => String(n).padStart(2, "0");
const want = [];
const pages = [];
let n = 0;
for (let pg = 0; pg < 6; pg++) {
  const lines = [{ y: 561, items: [{ x: 28, w: 200, s: "Joblist 08/10/2026 - 08/10/2026 — PICKS" }] }, head(530)];
  let y = 515;
  for (let k = 0; k < 50; k++, n++) {
    const vip = n % 7 === 0, longName = n % 11 === 0, hh = pad(Math.floor(n / 13) % 24), mm = pad((n * 7) % 60);
    const ref = vip ? "VIP APB-" + (1000 + n) : "CPD-19-" + (600000 + n), reg = "AB" + pad(n % 100) + "C" + String.fromCharCode(65 + (n % 26)) + "D";
    const name = longName ? "Customer Number " + n + " Longsurname" : "Customer " + n;
    want.push({ ref, reg, name });
    // dates above the main line, times below (as the real PDF draws them)
    lines.push({ y: y + 6, items: [{ x: X.meet, w: 40, s: "08/10/2026" }, { x: X.ret, w: 40, s: "1" + (n % 9 + 1) + "/10/2026" }] });
    const main = [{ x: X.name, w: 60, s: longName ? "Customer Number" : name }, { x: X.phone, w: 50, s: "07700 9" + String(n).padStart(5, "0") }, { x: X.reg, w: 40, s: reg }, { x: X.make, w: 50, s: "Ford Focus" }, { x: X.colour, w: 30, s: "Blue" }, { x: X.location, w: 20, s: "GS" }];
    if (vip) main.push({ x: 31, w: 6, s: "★" }, { x: 40, w: 14, s: "VIP" }, { x: 57, w: 30, s: "APB-" }); else main.push({ x: X.ref, w: 60, s: ref });
    lines.push({ y, items: main });
    const below = [{ x: X.meet, w: 30, s: hh + ":" + mm }, { x: X.ret, w: 30, s: "10:00" }];
    if (vip) below.push({ x: 28, w: 30, s: String(1000 + n) });
    if (longName) below.push({ x: X.name, w: 60, s: n + " Longsurname" });
    lines.push({ y: y - 5, items: below });
    y -= 21;   // the real sheets: about 20 points from one booking to the next
  }
  lines.sort((a, b) => b.y - a.y);
  pages.push(lines);
}
const t0 = Date.now();
let rows = [], kind = "";
for (const lines of pages) { const got = R.parseJoblistLines(lines, kind); kind = got.kind || kind; rows = rows.concat(got.rows); }
const ms = Date.now() - t0;
console.log("      300 bookings over 6 pages read in " + ms + " ms");
ok("all 300 bookings read, none merged or lost", rows.length === 300, rows.length);
ok("read as PICKS", kind === "picks", kind);
ok("every reference whole, VIP ones joined back together", want.every((w, i) => rows[i] && rows[i].ref.replace(/^VIP\s*/, "VIP ") === w.ref), rows.filter((r, i) => r.ref.replace(/^VIP\s*/, "VIP ") !== want[i].ref).slice(0, 3).map((r) => r.ref));
ok("every reg right", want.every((w, i) => rows[i] && rows[i].reg === w.reg));
ok("wrapped names joined back", want.every((w, i) => rows[i] && rows[i].name === w.name), rows.filter((r, i) => r.name !== want[i].name).slice(0, 3).map((r) => r.name));
ok("no reference twice", new Set(rows.map((r) => r.ref)).size === 300);
ok("drop-off times read", rows.every((r) => r.meet && r.meet.time));
ok("read in under 1 s", ms < 1000, ms);
console.log(failed ? failed + " failed" : "all passed");
process.exit(failed ? 1 : 0);
