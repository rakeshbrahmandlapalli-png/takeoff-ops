// TakeOff Ops: reads the booking site's downloads in the browser.
// The Excel (really a tab-separated file named .xls) and the Return Report PDF
// are opened on this device with SheetJS and PDF.js; nothing is uploaded until
// the office presses Create, and then only the columns the board uses.
// Proven on TAKEOFF's real downloads (17-18 Sep 2026): see AGENTS.md.
(function () {
  "use strict";
  function pad(n) { return String(n).padStart(2, "0"); }
  var LIBS = {
    xlsx: "/vendor/xlsx-0.18.5.full.min.js",
    pdf: "/vendor/pdf-3.11.174.min.js",
    pdfWorker: "/vendor/pdf-3.11.174.worker.min.js"
  };
  // One load per library: a second file read while it's still loading waits
  // for the same load, and a failed load is forgotten so "try again" works.
  var loading = {};
  function loadScript(src) {
    if (loading[src]) return loading[src];
    return (loading[src] = new Promise(function (resolve, reject) {
      var s = document.createElement("script"); s.src = src; s.onload = resolve;
      s.onerror = function () {
        s.remove(); delete loading[src];
        reject(new Error("Couldn't load the file reader. Check your connection and try again."));
      };
      document.head.appendChild(s);
    }));
  }
  // Header name -> what it is. Checked in this order; each column is used once.
  // Matches the booking site's own export (Reference Number, Car Reg, Client,
  // Booking From + Drop off Time, Booking To + Collection Time, Car Make/Model/
  // Colour, Valet Type for office notes) and similar lists from other sites.
  // A date column and its time column both map to the same field, date first.
  var HEADS = [
    ["status", /booking ?status|^status$/i],
    ["ref", /reference|^ref|booking ?(ref|no|number|id)/i],
    ["reg", /car ?reg|^reg|registration|number ?plate|vrm/i],
    ["name", /full ?name|customer|client|^name$/i],
    ["phone", /telephone|phone|mobile/i],
    ["flightIn", /inbound flight|return flight|arrival flight/i],
    ["flightOut", /outbound flight|departure flight/i],
    ["flight", /flight/i],
    ["vehicle", /car ?make|car ?model|car ?colou?r|vehicle|^make$|^model$|^colou?r$/i],
    // Office notes live in "Valet Type" on the booking site's export; its
    // "Addition Booking Information" column only ever holds a stray number.
    ["note", /valet ?type|^notes?$|comments?/i],
    ["meet", /booking ?from|drop.?off ?(date|time)|^meet/i],
    ["ret", /booking ?to\b|collection ?(date|time)|return ?(date|time)|^return$/i]
  ];
  var AIRLINES = "U2|EZY|EJU|FR|RYR|RK|W9|W6|WZZ|W4|LS|EXS|BY|TOM|BA|VY|TK|PC|EI|AF|KL|LH|IB|TP|A3|OS|LX|SN|SK|DY|D8|FI|JU|QS|MS|EK|QR|EY|WY|ET|PK|AI|6E|XQ|XC|H4|5O|PS|RO|0B|BT|LO|OK|FB|2L|X3|HV|TO|DS|EW|4U|VS|AA|UA|DL|BE|T3|LM|EN|WK|SM|MT|ZT|XR|GF|KU|SV|RJ|ME|LG|OU|JP|AZ|NT|UX|V7|HG|DE|JT|TB";
  var FLIGHT_RE = new RegExp("\\b(" + AIRLINES + ")\\s?(\\d{1,4}[A-Z]?)\\b");
  var UKREG = /([A-Z]{2}\d{2}\s?[A-Z]{3}|[A-Z]\d{1,3}\s?[A-Z]{3}|[A-Z]{3}\s?\d{1,3}[A-Z])\s*$/i;

  function parseDateTime(text) {
    var m = String(text || "").match(/(\d{1,4})[-\/.](\d{1,2})[-\/.](\d{2,4})(?:.*?\b(\d{1,2}):(\d{2}))?/);
    if (!m) return null;
    var y = +m[3], d = +m[1], mo = +m[2];
    if (m[1].length === 4) { y = +m[1]; d = +m[3]; }
    if (y < 100) y += 2000;
    var date = new Date(y, mo - 1, d, m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
    // A day or month that doesn't exist (31/09, or a US-style 09/16) is no date,
    // not a quietly different one the database would then refuse.
    if (isNaN(date) || date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
    return { date: date, key: y + "-" + pad(mo) + "-" + pad(d), time: m[4] ? pad(+m[4]) + ":" + m[5] : "" };
  }
  function boardName(key, kind) {
    var p = key.split("-"), d = new Date(+p[0], +p[1] - 1, +p[2]), n = d.getDate();
    var s = n % 100 >= 11 && n % 100 <= 13 ? "TH" : ({ 1: "ST", 2: "ND", 3: "RD" }[n % 10] || "TH");
    return n + s + " " + kind.toUpperCase() + " " + ["JAN", "FEB", "MAR", "APR", "MAY", "JUNE", "JULY", "AUG", "SEPT", "OCT", "NOV", "DEC"][d.getMonth()];
  }

  async function readExcel(file) {
    await loadScript(LIBS.xlsx);
    // raw: a download that's really a text file (BookingList .xls) keeps its dates as
    // written ("2026-09-23"); parsed, they became local midnight and moved an hour in summer.
    var wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: "array", cellNF: true, raw: true });
    var ws = wb.Sheets[wb.SheetNames[0]];
    var from1904 = !!(wb.Workbook && wb.Workbook.WBProps && wb.Workbook.WBProps.date1904);   // old Mac Excel counts from 1904
    // Excel keeps a date as a number of days, the time as the fraction: turned
    // into "yyyy-mm-dd" or "yyyy-mm-dd HH:MM" straight from that number, rounded
    // to the minute. Not through JavaScript dates, which moved a 01:00 return by
    // the summer-time hour and read 13:20 as 13:19. Not Excel's display text
    // either: SheetJS shows dates US-style (9/16/26).
    Object.keys(ws).forEach(function (k) {
      var cell = ws[k];
      if (k.charAt(0) === "!" || !cell || cell.t !== "n" || !cell.z || !XLSX.SSF.is_date(cell.z)) return;
      var mins = Math.round(cell.v * 1440), day = Math.floor(mins / 1440), m = mins - day * 1440;
      // A time-only cell (a separate "Return Time" column) is just the time.
      if (day === 0 && !from1904) { cell.t = "s"; cell.v = pad(Math.floor(m / 60)) + ":" + pad(m % 60); return; }
      var d = new Date(Date.UTC(1899, 11, 30) + (day + (from1904 ? 1462 : 0)) * 864e5);
      cell.t = "s"; cell.v = d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) + (m ? " " + pad(Math.floor(m / 60)) + ":" + pad(m % 60) : "");
    });
    var grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" }).map(function (row) {
      return row.map(function (v) { return v == null ? "" : String(v); });
    });
    var headRow = -1, cols = null;
    for (var r = 0; r < Math.min(grid.length, 20) && headRow < 0; r++) {
      var found = {}, used = {};
      HEADS.forEach(function (hd) {
        grid[r].forEach(function (cell, c) {
          var text = String(cell).replace(/\s+/g, " ").trim();
          if (!used[c] && text && text.length < 40 && hd[1].test(text)) { (found[hd[0]] = found[hd[0]] || []).push(c); used[c] = 1; }
        });
      });
      if ((found.ref || found.name) && Object.keys(found).length >= 3) { headRow = r; cols = found; }
    }
    if (headRow < 0) throw new Error("Couldn't find the column names (like Ref, Name, Vehicle, Return) in that Excel. Tell Rakesh which columns it has.");
    var get = function (row, key) { return (cols[key] || []).map(function (c) { return String(row[c] || "").trim(); }).filter(Boolean).join(" "); };
    var out = [];
    grid.slice(headRow + 1).forEach(function (row) {
      var ref = get(row, "ref"), name = get(row, "name");
      if (!ref && !name) return;
      if (/cancel/i.test(get(row, "status"))) return;
      var vehicle = get(row, "vehicle"), reg = get(row, "reg"), make = vehicle;
      if (!reg) { var m = vehicle.match(UKREG); if (m) { reg = m[1]; make = vehicle.slice(0, m.index).trim(); } }
      // The site's flight columns are sometimes filled with other values, so only
      // something shaped like a real flight number counts.
      var flight = function (key) { var m = get(row, key).toUpperCase().match(FLIGHT_RE); return m ? m[1] + m[2] : ""; };
      var note = get(row, "note").replace(/&pound;/g, "£");
      if (/^[\d.\s]*$/.test(note)) note = "";   // a stray number is not a note
      out.push({ ref: ref, name: name, phone: get(row, "phone"), make: make || "", reg: reg.toUpperCase().replace(/\s+/g, " "),
        flightIn: flight("flightIn") || flight("flight"), flightOut: flight("flightOut") || flight("flight"), note: note,
        meet: parseDateTime(get(row, "meet")), ret: parseDateTime(get(row, "ret")) });
    });
    return { rows: out, columns: Object.keys(cols) };
  }

  // The flights PDF is a table (Time, Car Reg, Flight No., Ref#, Client, ...).
  // Each value is put under the header whose centre it is closest to, so a
  // flight is read from the Flight No. column exactly as written ("W95488",
  // "Ls3868", "5332"), never guessed from the rest of the line.
  async function readPdf(file) {
    await loadScript(LIBS.pdf);
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = LIBS.pdfWorker;
    var doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    var heads = null, out = [];
    for (var p = 1; p <= doc.numPages; p++) {
      var content = await (await doc.getPage(p)).getTextContent(), byLine = {};
      content.items.forEach(function (it) {
        if (!String(it.str).trim()) return;
        var y = Math.round(it.transform[5] / 3);
        (byLine[y] = byLine[y] || []).push({ c: it.transform[4] + (it.width || 0) / 2, s: String(it.str).trim() });
      });
      Object.keys(byLine).sort(function (a, b) { return b - a; }).forEach(function (y) {
        var items = byLine[y];
        var isHead = items.some(function (i) { return /^flight/i.test(i.s); }) && items.some(function (i) { return /^ref|car ?reg/i.test(i.s); });
        if (isHead) {
          heads = items.map(function (i) {
            var key = /^flight/i.test(i.s) ? "flight" : /car ?reg|^reg/i.test(i.s) ? "reg" : /^ref/i.test(i.s) ? "ref" : "other";
            return { key: key, c: i.c };
          });
          return;
        }
        if (!heads) return;
        var row = { flight: "", reg: "", ref: "" };
        items.forEach(function (i) {
          var best = heads.reduce(function (a, b) { return Math.abs(b.c - i.c) < Math.abs(a.c - i.c) ? b : a; });
          if (best.key !== "other") row[best.key] += i.s;
        });
        if (row.reg || row.ref) out.push({ flight: row.flight.replace(/\s+/g, "").toUpperCase(), reg: row.reg, ref: row.ref });
      });
    }
    if (!heads) throw new Error("Couldn't find the Flight No. column in that PDF. Is it the right report?");
    return out;
  }

  // ── Back Office "Joblist" PDF ──────────────────────────────────────────
  // Airport Parking Bay's system only exports PDF, and unlike TAKEOFF's flights
  // report this PDF IS the booking list. One booking is drawn as a cluster of
  // two or three lines: the dates sit above the name, the times below it, and a
  // value too wide for its column is split down the same column. So the page is
  // read as clusters, and each cluster's cells are stacked back together.
  //
  //   y=515                  28/08/2026   01/09/2026
  //   y=509  SPF-000000      A N Other          AB12CDE  Ford Focus  Blue
  //   y=505                  06:00        07:30
  //
  // Columns are found by their headings, never by position: the 2024 and 2026
  // sheets already differ (2026 added Notes), so a fixed layout would rot.
  var JOB_COLS = [
    ["ref", /^id$/i], ["name", /customer|client/i], ["phone", /mobile|telephone|phone/i],
    ["meet", /departure date|drop.?off/i], ["ret", /return date|collection/i],
    ["reg", /vehicle reg|car ?reg|^reg/i], ["make", /make ?(&|and)? ?model|^make$/i],
    ["colour", /colou?r/i], ["flight", /^flight$/i], ["landing", /landing/i],
    ["pt", /^pt$/i], ["location", /^location$/i], ["note", /^notes?$/i]
  ];

  // Two fragments stacked in one column may be one word the PDF broke in half
  // ("Champag" + "ne") or two words it wrapped at the space ("Not" +
  // "provided"). Joined wrongly you get "Champag ne" or "Notprovided".
  //
  // A broken word leaves a long first piece and a short lower-case tail, so
  // that — and only that — is glued back together. "Dark" + "red" keeps its
  // space because "Dark" is short enough to have been a whole word; "Not" +
  // "provided" keeps its space because the tail is a word in its own right.
  function joinCell(parts) {
    var text = "";
    parts.forEach(function (p, i) {
      if (!i) { text = p.s; return; }
      var prev = parts[i - 1].s;
      var split = prev.length >= 5 && /[a-z]$/.test(prev) && /^[a-z]{1,3}$/.test(p.s);
      text += (split ? "" : " ") + p.s;
    });
    return text.replace(/\s+/g, " ").trim();
  }

  // Pure, so it can be tested against the real PDFs outside a browser.
  // lines: [{ y, items: [{ x, w, s }] }], newest (highest y) first.
  function parseJoblistLines(lines, kindHint) {
    var headIdx = -1, cols = null, kind = kindHint || "";
    for (var i = 0; i < lines.length && headIdx < 0; i++) {
      var found = [];
      lines[i].items.forEach(function (it) {
        for (var k = 0; k < JOB_COLS.length; k++) {
          if (JOB_COLS[k][1].test(it.s) && !found.some(function (f) { return f.key === JOB_COLS[k][0]; })) {
            found.push({ key: JOB_COLS[k][0], x: it.x }); return;
          }
        }
      });
      if (found.some(function (f) { return f.key === "ref"; }) && found.length >= 5) { headIdx = i; cols = found; }
      else if (/joblist/i.test(lines[i].items.map(function (t) { return t.s; }).join(" "))) {
        var t = lines[i].items.map(function (x) { return x.s; }).join(" ");
        if (/picks/i.test(t)) kind = "picks"; else if (/drops/i.test(t)) kind = "drops";
      }
    }
    if (headIdx < 0) throw new Error("Couldn't find the column headings (ID, Customer, Mobile No…) in that PDF. Is it a Joblist export?");

    cols.sort(function (a, b) { return a.x - b.x; });
    cols.forEach(function (c, i) { c.end = i + 1 < cols.length ? cols[i + 1].x : 1e6; });
    var colOf = function (x) {
      for (var i = cols.length - 1; i >= 0; i--) if (x >= cols[i].x - 6) return cols[i];
      return cols[0];
    };

    // Cluster the rest. Inside a booking the lines sit a few points apart; from
    // one booking to the next the step is about three times that. Which of the
    // two is more common changes with the sheet — on a DROPS page nearly every
    // booking is three lines, on a PICKS page most are one — so the row pitch is
    // taken from near the top of the range (the between-booking step) rather
    // than the middle, and anything under two thirds of it is a continuation.
    var body = lines.slice(headIdx + 1).filter(function (l) { return l.items.length; });
    var gaps = [];
    for (var g = 1; g < body.length; g++) gaps.push(body[g - 1].y - body[g].y);
    gaps.sort(function (a, b) { return a - b; });
    var pitch = gaps.length ? gaps[Math.floor(gaps.length * 0.9)] : 15;
    var split = Math.max(7, pitch * 0.6);

    var groups = [], cur = [];
    body.forEach(function (l, i) {
      if (i && body[i - 1].y - l.y > split) { if (cur.length) groups.push(cur); cur = []; }
      cur.push(l);
    });
    if (cur.length) groups.push(cur);

    var out = [];
    groups.forEach(function (grp) {
      var cells = {};
      grp.forEach(function (line) {
        line.items.slice().sort(function (a, b) { return a.x - b.x; }).forEach(function (it) {
          var c = colOf(it.x);
          (cells[c.key] = cells[c.key] || []).push({ s: it.s, ran: false });
        });
      });
      var v = function (k) { return cells[k] ? joinCell(cells[k]) : ""; };
      // "★ VIP APB-" then "1133" on the next line is one reference.
      var ref = v("ref").replace(/^[★*\s]+/, "").replace(/-\s+/g, "-").trim();
      var name = v("name"), reg = v("reg").toUpperCase().replace(/\s+/g, " ").trim();
      if (!ref && !name && !reg) return;
      var make = [v("make"), v("colour")].filter(function (s) { return s && s !== "."; }).join(" ").trim();
      var flight = v("flight").toUpperCase().replace(/\s+/g, "");
      if (/^(TBC|NOTPROVIDED|N\/A|-)?$/i.test(flight)) flight = "";
      var note = [v("location"), v("note")].filter(Boolean).join(" · ").replace(/^\.$|^·\s*/, "").trim();
      out.push({
        ref: ref, name: name, phone: v("phone"), make: make, reg: reg,
        flightIn: flight, flightOut: "", note: note,
        meet: parseDateTime(v("meet")), ret: parseDateTime(v("ret"))
      });
    });
    return { rows: out, kind: kind, columns: cols.map(function (c) { return c.key; }) };
  }

  async function readJoblistPdf(file) {
    await loadScript(LIBS.pdf);
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = LIBS.pdfWorker;
    var doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    var all = [], kind = "";
    for (var p = 1; p <= doc.numPages; p++) {
      var content = await (await doc.getPage(p)).getTextContent(), byY = {};
      content.items.forEach(function (it) {
        var s = String(it.str).trim(); if (!s) return;
        var y = Math.round(it.transform[5]);
        (byY[y] = byY[y] || []).push({ x: it.transform[4], w: it.width || 0, s: s });
      });
      var lines = Object.keys(byY).map(Number).sort(function (a, b) { return b - a; })
        .map(function (y) { return { y: y, items: byY[y] }; });
      var got = parseJoblistLines(lines, kind);
      kind = got.kind || kind;
      all = all.concat(got.rows);
    }
    return { rows: all, kind: kind };
  }

  // Reference first: it is unique to one booking. Then Car Reg, but only when
  // that reg has one flight in the PDF: a two-day report can hold the same car
  // twice, and a wrong flight is worse than a red row someone checks.
  function matchFlights(rows, pdfRows, field) {
    var squash = function (s) { return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); };
    var byReg = {}, byRef = {}, matched = 0;
    pdfRows.forEach(function (p) {
      if (!p.flight) return;
      if (squash(p.ref).length >= 5) byRef[squash(p.ref)] = p.flight;
      var reg = squash(p.reg);
      if (reg.length >= 4) (byReg[reg] = byReg[reg] || {})[p.flight] = 1;
    });
    rows.forEach(function (r) {
      var regFlights = byReg[squash(r.reg)] ? Object.keys(byReg[squash(r.reg)]) : [];
      var hit = byRef[squash(r.ref)] || (regFlights.length === 1 ? regFlights[0] : "");
      if (hit) { r[field] = hit; matched++; }
    });
    return matched;
  }


  window.TakeoffReader = { readExcel: readExcel, readPdf: readPdf, readJoblistPdf: readJoblistPdf,
    parseJoblistLines: parseJoblistLines, matchFlights: matchFlights, parseDateTime: parseDateTime, boardName: boardName };
})();
