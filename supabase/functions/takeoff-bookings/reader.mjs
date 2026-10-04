// Server port of public/reader.js for TakeOff's booking site (Swift Airport
// Parking admin). PURE functions only: the edge function does the I/O (SheetJS
// to a grid, pdf.js to lines) and calls these. Kept line-for-line with the
// browser reader so the automatic import reads a download exactly as the office
// does by hand. Tested in checks/import-reader.mjs.

function pad(n) { return String(n).padStart(2, "0"); }

// Header name -> field. Same order and patterns as public/reader.js.
export const HEADS = [
  ["status", /booking ?status|^status$/i],
  ["ref", /reference|^ref|booking ?(ref|no|number|id)/i],
  ["reg", /car ?reg|^reg|registration|number ?plate|vrm/i],
  ["name", /full ?name|customer|client|^name$/i],
  ["phone", /telephone|phone|mobile/i],
  ["flightIn", /inbound flight|return flight|arrival flight/i],
  ["flightOut", /outbound flight|departure flight/i],
  ["flight", /flight/i],
  ["vehicle", /car ?make|car ?model|car ?colou?r|vehicle|^make$|^model$|^colou?r$/i],
  ["note", /valet ?type|^notes?$|comments?/i],
  ["meet", /booking ?from|drop.?off ?(date|time)|^meet/i],
  ["ret", /booking ?to\b|collection ?(date|time)|return ?(date|time)|^return$/i]
];
const AIRLINES = "U2|EZY|EJU|FR|RYR|RK|W9|W6|WZZ|W4|LS|EXS|BY|TOM|BA|VY|TK|PC|EI|AF|KL|LH|IB|TP|A3|OS|LX|SN|SK|DY|D8|FI|JU|QS|MS|EK|QR|EY|WY|ET|PK|AI|6E|XQ|XC|H4|5O|PS|RO|0B|BT|LO|OK|FB|2L|X3|HV|TO|DS|EW|4U|VS|AA|UA|DL|BE|T3|LM|EN|WK|SM|MT|ZT|XR|GF|KU|SV|RJ|ME|LG|OU|JP|AZ|NT|UX|V7|HG|DE|JT|TB";
const FLIGHT_RE = new RegExp("\\b(" + AIRLINES + ")\\s?(\\d{1,4}[A-Z]?)\\b");
const UKREG = /([A-Z]{2}\d{2}\s?[A-Z]{3}|[A-Z]\d{1,3}\s?[A-Z]{3}|[A-Z]{3}\s?\d{1,3}[A-Z])\s*$/i;

export function parseDateTime(text) {
  const m = String(text || "").match(/(\d{1,4})[-\/.](\d{1,2})[-\/.](\d{2,4})(?:.*?\b(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  let y = +m[3], d = +m[1], mo = +m[2];
  if (m[1].length === 4) { y = +m[1]; d = +m[3]; }
  if (y < 100) y += 2000;
  const date = new Date(y, mo - 1, d, m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
  if (isNaN(date) || date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return { key: y + "-" + pad(mo) + "-" + pad(d), time: m[4] ? pad(+m[4]) + ":" + m[5] : "" };
}

// grid: array of rows, each an array of cell strings (dates already normalised
// to "yyyy-mm-dd[ HH:MM]" by the caller, as the browser reader does with SheetJS).
export function parseExcelGrid(grid) {
  let headRow = -1, cols = null;
  for (let r = 0; r < Math.min(grid.length, 20) && headRow < 0; r++) {
    const found = {}, used = {};
    HEADS.forEach(function (hd) {
      grid[r].forEach(function (cell, c) {
        const text = String(cell).replace(/\s+/g, " ").trim();
        if (!used[c] && text && text.length < 40 && hd[1].test(text)) { (found[hd[0]] = found[hd[0]] || []).push(c); used[c] = 1; }
      });
    });
    if ((found.ref || found.name) && Object.keys(found).length >= 3) { headRow = r; cols = found; }
  }
  if (headRow < 0) throw new Error("Couldn't find the column names (like Ref, Name, Vehicle, Return) in that download.");
  const get = function (row, key) { return (cols[key] || []).map(function (c) { return String(row[c] || "").trim(); }).filter(Boolean).join(" "); };
  const out = [];
  grid.slice(headRow + 1).forEach(function (row) {
    const ref = get(row, "ref"), name = get(row, "name");
    if (!ref && !name) return;
    if (/cancel/i.test(get(row, "status"))) return;
    let vehicle = get(row, "vehicle"), reg = get(row, "reg"), make = vehicle;
    if (!reg) { const m = vehicle.match(UKREG); if (m) { reg = m[1]; make = vehicle.slice(0, m.index).trim(); } }
    const flight = function (key) { const m = get(row, key).toUpperCase().match(FLIGHT_RE); return m ? m[1] + m[2] : ""; };
    let note = get(row, "note").replace(/&pound;/g, "£");
    if (/^[\d.\s]*$/.test(note)) note = "";
    out.push({ ref: ref, name: name, phone: get(row, "phone"), make: make || "", reg: reg.toUpperCase().replace(/\s+/g, " "),
      flightIn: flight("flightIn") || flight("flight"), flightOut: flight("flightOut") || flight("flight"), note: note,
      meet: parseDateTime(get(row, "meet")), ret: parseDateTime(get(row, "ret")) });
  });
  return { rows: out, columns: Object.keys(cols) };
}

// lines: [{ y, items:[{c,s}] }] newest first — from the Return Report PDF.
export function parseFlightLines(lines) {
  let heads = null; const out = [];
  lines.forEach(function (ln) {
    const items = ln.items;
    const isHead = items.some(function (i) { return /^flight/i.test(i.s); }) && items.some(function (i) { return /^ref|car ?reg/i.test(i.s); });
    if (isHead) {
      heads = items.map(function (i) {
        const key = /^flight/i.test(i.s) ? "flight" : /car ?reg|^reg/i.test(i.s) ? "reg" : /^ref/i.test(i.s) ? "ref" : "other";
        return { key: key, c: i.c };
      });
      return;
    }
    if (!heads) return;
    const row = { flight: "", reg: "", ref: "" };
    items.forEach(function (i) {
      const best = heads.reduce(function (a, b) { return Math.abs(b.c - i.c) < Math.abs(a.c - i.c) ? b : a; });
      if (best.key !== "other") row[best.key] += i.s;
    });
    if (row.reg || row.ref) out.push({ flight: row.flight.replace(/\s+/g, "").toUpperCase(), reg: row.reg, ref: row.ref });
  });
  if (!heads) throw new Error("Couldn't find the Flight No. column in that PDF. Is it the Return Report?");
  return out;
}

export function matchFlights(rows, pdfRows, field) {
  const squash = function (s) { return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); };
  const byReg = {}, byRef = {}; let matched = 0;
  pdfRows.forEach(function (p) {
    if (!p.flight) return;
    if (squash(p.ref).length >= 5) byRef[squash(p.ref)] = p.flight;
    const reg = squash(p.reg);
    if (reg.length >= 4) (byReg[reg] = byReg[reg] || {})[p.flight] = 1;
  });
  rows.forEach(function (r) {
    const regFlights = byReg[squash(r.reg)] ? Object.keys(byReg[squash(r.reg)]) : [];
    const hit = byRef[squash(r.ref)] || (regFlights.length === 1 ? regFlights[0] : "");
    if (hit) { r[field] = hit; matched++; }
  });
  return matched;
}

// ── day grouping, identical to the browser import (app.js) ──
export function addDaysKey(key, n) { const d = new Date(key + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
export function shiftKey(dt, cutoff) {
  if (!dt) return "";
  if (!dt.time || cutoff === "00:00" || dt.time > cutoff) return dt.key;
  return addDaysKey(dt.key, -1);
}
function local(dt) { return dt ? dt.key + " " + (dt.time || "00:00") : ""; }

// Group parsed rows into day-sheets and shape each row exactly as the browser
// sends to import_sheet. kind: "drops" groups by return day (cutoff = the
// company's drops_day_end, e.g. "06:00"); "picks" groups by meet day (cutoff
// "00:00"). Returns [{ day, rows:[...] }] sorted by day.
export function groupForImport(rows, kind, cutoff) {
  const field = kind === "drops" ? "ret" : "meet";
  const byDay = {};
  rows.forEach(function (r) {
    const key = shiftKey(r[field], kind === "drops" ? cutoff : "00:00");
    if (!key) return;
    (byDay[key] = byDay[key] || []).push({
      ref: r.ref, reg: r.reg, name: r.name, phone: r.phone, make: r.make,
      drop_local: local(r.meet), return_local: local(r.ret),
      flight: kind === "drops" ? (r.flightIn || "") : "", note: r.note || ""
    });
  });
  return Object.keys(byDay).sort().map(function (day) { return { day: day, rows: byDay[day] }; });
}
