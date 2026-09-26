// Date checks: shift day, return day and overstay charges around the UK clock
// changes (25 Oct 2026 back, 29 Mar 2026 forward). Run: node checks/dates.cjs
const src = require("fs").readFileSync(require("path").join(__dirname, "../public/app.js"), "utf8");
const grab = (name) => { const i = src.indexOf("function " + name + "("); let d = 0, j = src.indexOf("{", i); for (let k = j; k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1); } };
let NOW;
const code = "var FMT = {};\n" + ["fmt", "londonParts", "addDaysKey", "overstayDue", "returnDay", "currentShiftKey"].map(grab).join("\n");
const make = new Function("S", "TZ", "Date", code + "; return { overstayDue, returnDay, currentShiftKey, londonParts };");
class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return NOW; } }
FakeDate.parse = Date.parse;
const S = { company: { overstay_rate: 30, drops_day_end: "06:00:00" } };
const f = make(S, "Europe/London", FakeDate);
const at = (utc) => { NOW = Date.parse(utc); };
let fails = 0; const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log((ok ? "ok   " : "FAIL ") + name + (ok ? "" : "  got " + JSON.stringify(got) + " want " + JSON.stringify(want))); };
// shift day across the change (clocks go back 25 Oct 02:00 BST -> 01:00 GMT)
at("2026-10-24T23:30:00Z"); t("00:30 BST 25th is still the 24th shift", f.currentShiftKey(), "2026-10-24");
at("2026-10-25T00:30:00Z"); t("first 01:30 (BST) is the 24th shift", f.currentShiftKey(), "2026-10-24");
at("2026-10-25T01:30:00Z"); t("second 01:30 (GMT) is the 24th shift", f.currentShiftKey(), "2026-10-24");
at("2026-10-25T05:59:00Z"); t("05:59 GMT still the 24th shift", f.currentShiftKey(), "2026-10-24");
at("2026-10-25T06:01:00Z"); t("06:01 GMT starts the 25th shift", f.currentShiftKey(), "2026-10-25");
at("2026-03-29T05:30:00Z"); t("spring: 06:30 BST 29 Mar is the 29th shift", f.currentShiftKey(), "2026-03-29");
// return day with the 06:00 day end
t("return 25th 01:30 GMT belongs to the 24th", f.returnDay({ return_at: "2026-10-25T01:30:00Z" }), "2026-10-24");
t("return 25th 07:00 GMT belongs to the 25th", f.returnDay({ return_at: "2026-10-25T07:00:00Z" }), "2026-10-25");
// overstay charges over the change
const r1 = { kind: "drops", return_at: "2026-10-24T22:00:00Z" };  // 24th 23:00 BST
at("2026-10-25T05:30:00Z"); t("24th 23:00 return: free until 06:00 on the 25th", f.overstayDue(r1), null);
at("2026-10-25T06:30:00Z"); t("…06:30 GMT 25th: 1 day", f.overstayDue(r1), { days: 1, amount: 30 });
at("2026-10-26T06:30:00Z"); t("…06:30 26th: 2 days", f.overstayDue(r1), { days: 2, amount: 60 });
const r2 = { kind: "drops", return_at: "2026-10-25T00:30:00Z" };  // 25th 01:30 BST (before day end)
at("2026-10-25T11:59:00Z"); t("25th 01:30 return: free until 12:00 that day", f.overstayDue(r2), null);
at("2026-10-25T12:30:00Z"); t("…12:30 25th: 1 day", f.overstayDue(r2), { days: 1, amount: 30 });
at("2026-10-26T00:30:00Z"); t("…00:30 26th: 2 days", f.overstayDue(r2), { days: 2, amount: 60 });
const r3 = { kind: "drops", return_at: "2026-10-30T23:00:00Z", orig_return_at: "2026-10-24T22:00:00Z" };
at("2026-10-30T23:30:00Z"); t("changed return charged from the 24th: 6 days on the 30th", f.overstayDue(r3), { days: 6, amount: 180 });
console.log(fails ? fails + " FAILED" : "all passed"); process.exitCode = fails ? 1 : 0;
