// Reads Airport Parking Bay's real Back Office PDFs through the SHIPPING
// reader.js and checks what comes out, so a change to the parser cannot quietly
// start producing wrong cars.
//
//   cd checks && npm install pdfjs-dist@3.11.174 && node joblist.cjs
//
// The sample PDFs are not in the repo: they hold real customers' names, phone
// numbers and registrations. Point SAMPLES at wherever they live.
const fs = require("fs"), path = require("path"), vm = require("vm");
const pdfjs = require("pdfjs-dist/legacy/build/pdf.js");

const SAMPLES = process.env.JOBLIST_SAMPLES || "C:/Users/Rakesh/Downloads";
const FILES = {
  drops2026: "DROP SHEET 0109_260920_030926.pdf",
  picks2026: "PICKS 0109_260920_031007.pdf",
  drops2024: "Backoffice.pdf",
};

// Load reader.js exactly as a browser would, so this tests the shipped file.
const win = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "public", "reader.js"), "utf8"), {
  window: win, console, Promise, Math, String, Number, Date, RegExp, Object, Array, JSON,
  document: { querySelector: () => null, head: { appendChild() {} }, createElement: () => ({}) },
});
const R = win.TakeoffReader;

let failed = 0;
const ok = (name, cond, detail) => {
  console.log((cond ? "PASS " : "FAIL ") + name + (cond || detail === undefined ? "" : "  -> " + JSON.stringify(detail)));
  if (!cond) failed++;
};

async function read(file) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)) }).promise;
  let rows = [], kind = "";
  for (let p = 1; p <= doc.numPages; p++) {
    const c = await (await doc.getPage(p)).getTextContent(), byY = {};
    for (const it of c.items) {
      const s = String(it.str).trim(); if (!s) continue;
      const y = Math.round(it.transform[5]);
      (byY[y] = byY[y] || []).push({ x: it.transform[4], w: it.width || 0, s });
    }
    const lines = Object.keys(byY).map(Number).sort((a, b) => b - a).map((y) => ({ y, items: byY[y] }));
    const got = R.parseJoblistLines(lines, kind);
    kind = got.kind || kind;
    rows = rows.concat(got.rows);
  }
  return { rows, kind };
}

(async () => {
  const missing = Object.values(FILES).filter((f) => !fs.existsSync(path.join(SAMPLES, f)));
  if (missing.length) {
    console.log("Sample PDFs not found in " + SAMPLES + ":\n  " + missing.join("\n  ") +
      "\nSet JOBLIST_SAMPLES to the folder holding them.");
    process.exit(2);
  }

  const drops = await read(path.join(SAMPLES, FILES.drops2026));
  const picks = await read(path.join(SAMPLES, FILES.picks2026));
  const old = await read(path.join(SAMPLES, FILES.drops2024));

  // ── the sheet is understood at all ──────────────────────────────────────
  ok("drops sheet reads as DROPS", drops.kind === "drops", drops.kind);
  ok("picks sheet reads as PICKS", picks.kind === "picks", picks.kind);
  ok("2024 sheet still reads (layout changed: it has no Notes column)", old.rows.length > 30, old.rows.length);

  // ── every booking arrives, and none is invented ─────────────────────────
  // Counted by hand from the PDFs on 20 Sep 2026.
  ok("drops: 65 bookings", drops.rows.length === 65, drops.rows.length);
  ok("picks: 36 bookings", picks.rows.length === 36, picks.rows.length);
  ok("2024 drops: 37 bookings", old.rows.length === 37, old.rows.length);

  for (const [label, set] of [["drops", drops], ["picks", picks], ["2024", old]]) {
    const r = set.rows;
    ok(label + ": every row has a reference", r.every((x) => x.ref), r.filter((x) => !x.ref).slice(0, 2));
    ok(label + ": every row has a customer", r.every((x) => x.name), r.filter((x) => !x.name).slice(0, 2));
    ok(label + ": every row has both dates", r.every((x) => x.meet && x.ret), r.filter((x) => !x.meet || !x.ret).slice(0, 2));
    ok(label + ": no reference swallowed its neighbour", r.every((x) => x.ref.length <= 24), r.filter((x) => x.ref.length > 24).map((x) => x.ref).slice(0, 2));
    ok(label + ": return is never before drop-off", r.every((x) => x.ret.date >= x.meet.date), r.filter((x) => x.ret.date < x.meet.date).slice(0, 2));
  }

  // ── the awkward shapes, named one by one ────────────────────────────────
  const ivan = drops.rows.find((x) => /Ivan/.test(x.name));
  ok("a VIP reference split over two lines is rejoined", ivan && ivan.ref === "VIP APB-1133", ivan && ivan.ref);
  ok("the star before a VIP reference is dropped", drops.rows.every((x) => !/[★*]/.test(x.ref)));

  const champ = drops.rows.find((x) => /Champ/i.test(x.make));
  ok("a word the PDF split is put back ('Champagne')", champ && /Champagne/.test(champ.make), champ && champ.make);

  const grand = picks.rows.find((x) => /Samantha/i.test(x.name));
  ok("a wrapped model keeps its space ('Renault Grand Scenic')", grand && grand.make.startsWith("Renault Grand Scenic"), grand && grand.make);

  const darkred = picks.rows.find((x) => /Dark Red/i.test(x.make));
  ok("two short words are NOT glued ('Dark Red')", !!darkred, picks.rows.slice(0, 3).map((x) => x.make));

  const notprovided = drops.rows.find((x) => /Ivan/.test(x.name));
  ok("'Not provided' is treated as no flight", notprovided && notprovided.flightIn === "", notprovided && notprovided.flightIn);
  ok("'TBC' is treated as no flight", drops.rows.every((x) => !/TBC/i.test(x.flightIn)));

  const spaced = old.rows.find((x) => x.reg === "F4 SBA");
  ok("a registration with a space survives", !!spaced, old.rows.slice(0, 5).map((x) => x.reg));
  const nonUk = old.rows.find((x) => x.reg === "6041DH");
  ok("a registration that is not a UK plate survives", !!nonUk);

  const dot = old.rows.find((x) => /Renault Gran Scenic/.test(x.make));
  ok("a colour written as '.' is dropped", dot && !/\./.test(dot.make), dot && dot.make);

  // Phones arrive in five shapes; the reader keeps them as written and the app
  // normalises later. What matters here is that none is mangled or lost.
  const phones = old.rows.map((x) => x.phone);
  ok("a phone with no leading zero is kept", phones.some((p) => /^7\d{9}$/.test(p)), phones.slice(0, 3));
  ok("a phone written +44 0… is kept", phones.some((p) => /^\+44 0/.test(p)), phones.filter((p) => /^\+/.test(p)).slice(0, 2));
  ok("every row has a phone", old.rows.every((x) => x.phone), old.rows.filter((x) => !x.phone).slice(0, 2));

  // ── dates are British, not American ─────────────────────────────────────
  const first = old.rows[0];
  ok("05/08/2024 is 5 August, not 8 May", first.ret.key === "2024-08-05", first.ret.key);
  ok("a time on the line below joins its date", first.meet.time === "16:30", first.meet.time);

  // ── it fails loudly on the wrong file ───────────────────────────────────
  let threw = "";
  try { R.parseJoblistLines([{ y: 1, items: [{ x: 0, w: 5, s: "nothing useful" }] }], ""); }
  catch (e) { threw = e.message; }
  ok("a PDF that is not a Joblist is refused", /Joblist/i.test(threw), threw);

  console.log(failed ? "\n" + failed + " FAILED" : "\nall " + "passed");
  process.exit(failed ? 1 : 0);
})();
