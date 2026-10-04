// Proves the server reader (supabase/functions/takeoff-bookings/reader.mjs)
// reads TakeOff's Swift Airport Parking downloads the way the office does.
// Columns mirror the real admin screens (3-4 Oct 2026). No real data here.
//   node checks/import-reader.mjs
import { parseExcelGrid, parseFlightLines, matchFlights, parseDateTime } from "../supabase/functions/takeoff-bookings/reader.mjs";

let failed = 0;
const ok = (name, cond, detail) => { console.log((cond ? "PASS " : "FAIL ") + name + (cond || detail === undefined ? "" : "  -> " + JSON.stringify(detail))); if (!cond) failed++; };

// ── Booking List export (DROPS / PICKS). The office's own column order. ──
const grid = [
  ["Ref#", "Supplier Name", "Booking Type", "Payment Status", "Full Name", "Booked", "Meet", "Return", "Vehicle", "Total Days", "V/Code", "V/Value", "Booking Status"],
  ["LJKDQS", "HES", "PR", "Payment Success", "MR A BOUGHTON", "2026-09-29 17:16", "2026-10-05 15:00", "2026-10-07 19:00", "TESLA MODEL 3 LONG RANGE RWD GL25ZPB", "3", "", "0.00", "Booked"],
  ["LFNRZZ", "HES", "PR", "Payment Success", "MISS K SKILTON", "2026-08-28 17:16", "2026-10-05 14:00", "2026-10-09 23:30", "SEAT ARONA FR SPORT ECOTSI DV74GMU", "5", "", "0.00", "Booked"],
  ["APL-115397", "APL", "MG", "Payment Success", "Mrs. Aleksandra Lipinska", "2026-09-24 07:24", "2026-10-05 13:00", "2026-10-07 20:45", "Mazda 6 PN66LJU", "3", "", "0.00", "Booked"],
  ["LHSXJS", "HES", "PR", "Cancelled", "MR T TEMPBOOKING", "2026-09-22 11:16", "2026-10-05 09:00", "2026-10-09 17:00", "- -", "5", "", "0.00", "Cancelled"],
];
const ex = parseExcelGrid(grid);
ok("reads every non-cancelled booking", ex.rows.length === 3, ex.rows.length);
const b = ex.rows[0];
ok("reference kept", b.ref === "LJKDQS", b.ref);
ok("name kept", b.name === "MR A BOUGHTON", b.name);
ok("reg split from the end of Vehicle", b.reg === "GL25ZPB", b.reg);
ok("make is the vehicle without the reg", b.make === "TESLA MODEL 3 LONG RANGE RWD", b.make);
ok("meet date+time read", b.meet && b.meet.key === "2026-10-05" && b.meet.time === "15:00", b.meet);
ok("return date+time read", b.ret && b.ret.key === "2026-10-07" && b.ret.time === "19:00", b.ret);
ok("short-style reg (Mazda 6 PN66LJU) split", ex.rows[2].reg === "PN66LJU", ex.rows[2].reg);
ok("cancelled booking left out (flagged by the office, not auto-removed here)", !ex.rows.some(r => r.ref === "LHSXJS"));
ok("no flight from the Excel (that comes from the PDF)", !b.flightIn && !b.flightOut);

// ── Return Report PDF (flight numbers). Nearest-column reading. ──
// Header then rows; c = column centre (x). Flight No. | Car Reg | Ref#.
const H = { y: 100, items: [{ c: 50, s: "Ref#" }, { c: 150, s: "Car Reg" }, { c: 250, s: "Flight No." }] };
const lines = [
  H,
  { y: 90, items: [{ c: 50, s: "LJKDQS" }, { c: 150, s: "GL25ZPB" }, { c: 250, s: "U22312" }] },
  { y: 80, items: [{ c: 50, s: "LFNRZZ" }, { c: 150, s: "DV74GMU" }, { c: 250, s: "EZY2426" }] },
];
const pdf = parseFlightLines(lines);
ok("PDF: reads a flight per row from the Flight No. column", pdf.length === 2 && pdf[0].flight === "U22312", pdf);

// ── matching flights onto the DROPS rows by reference ──
const n = matchFlights(ex.rows, pdf, "flightIn");
ok("flights matched onto bookings by reference", n === 2 && ex.rows[0].flightIn === "U22312" && ex.rows[1].flightIn === "EZY2426", ex.rows.map(r => [r.ref, r.flightIn]));

// ── date guard: an impossible date is rejected, not quietly shifted ──
ok("31-09 is rejected (no such day)", parseDateTime("31-09-2026 10:00") === null);
ok("a real date passes", parseDateTime("05-10-2026 15:00").key === "2026-10-05");

console.log(failed ? ("\n" + failed + " FAILED") : "\nAll reader checks passed.");
process.exit(failed ? 1 : 0);
