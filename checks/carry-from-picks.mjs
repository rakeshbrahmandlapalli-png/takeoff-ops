// Setup part 68 (PICKS location and money carry to DROPS) on a throwaway
// in-memory Postgres (PGlite), with just the tables and columns it touches.
//   cd checks && npm install @electric-sql/pglite && node carry-from-picks.mjs
import { PGlite } from "@electric-sql/pglite";
import fs from "fs";
const db = new PGlite();
await db.exec(`
create table companies (id uuid primary key default gen_random_uuid(), slug text, brand jsonb not null default '{}', yards text[] default '{GS,MY,T}');
create table staff (id uuid primary key default gen_random_uuid(), name text);
create table bookings (id uuid primary key default gen_random_uuid(), company_id uuid, sheet_id uuid, kind text, ref text not null default '', reg text not null default '', name text not null default '',
  drop_at timestamptz, return_at timestamptz, yard text not null default '', yard_before_t text not null default '', note text not null default '', num int,
  removed_at timestamptz, cleared_at timestamptz, charge_agreed numeric(8,2), charge_reason text not null default '', charge_at timestamptz, updated_at timestamptz);
create table activity (id bigint generated always as identity primary key, company_id uuid, staff_id uuid, staff_name text not null default '', sheet_id uuid, booking_id uuid, reg text, customer text, action text, value text);
create function me() returns staff language sql as $$ select null::staff $$;
create or replace function log_activity(p_booking bookings, p_action text, p_value text)
returns void language plpgsql security definer set search_path = public as $$
declare s staff := me();
begin
  insert into activity(company_id, staff_id, staff_name, sheet_id, booking_id, reg, customer, action, value)
  values (p_booking.company_id, s.id, coalesce(s.name, ''), p_booking.sheet_id, p_booking.id, p_booking.reg, p_booking.name, p_action, coalesce(p_value, ''));
end; $$;
create role anon; create role authenticated;
insert into companies(slug, brand) values ('apb', '{"picks_yard": true}'), ('takeoff', '{}');
`);
await db.exec(fs.readFileSync(new URL("../setup/68-carry-from-picks.sql", import.meta.url), "utf8"));
await db.exec(fs.readFileSync(new URL("../setup/68-carry-from-picks.sql", import.meta.url), "utf8")); // safe to run twice
const q = async (s) => (await db.query(s)).rows;
const co = (slug) => `(select id from companies where slug='${slug}')`;
let fails = 0; const ok = (n, c, d) => { console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + JSON.stringify(d))); if (!c) fails++; };
const pick = (slug, ref, reg, yard, note, dropAgo = "2 days") => db.exec(`insert into bookings(company_id, kind, ref, reg, drop_at, return_at, yard, note) values (${co(slug)}, 'picks', '${ref}', '${reg}', now() - interval '${dropAgo}', now() + interval '1 day', '${yard}', '${note}')`);
const drop = (slug, ref, reg, extra = {}) => db.exec(`insert into bookings(company_id, kind, ref, reg, drop_at, return_at, note, yard) values (${co(slug)}, 'drops', '${ref}', '${reg}', now() - interval '2 days', now() + interval '1 day', '${extra.note || ""}', '${extra.yard || ""}')`);
const d = async (ref) => (await q(`select yard, note, charge_agreed::text amt, charge_reason from bookings where kind='drops' and ref='${ref}'`))[0];

// 1. import after the location was set
await pick("apb", "R1", "BU15DDE", "GS", "£20 due, keys in office");
await drop("apb", "R1", "BU15DDE", { note: "S/D" });
let r = await d("R1");
ok("drops car takes the PICKS location", r.yard === "GS", r);
ok("PICKS note added to the drops note", r.note === "S/D · PICKS: £20 due, keys in office", r);
ok("£ in the note becomes the charge due", r.amt === "20.00" && r.charge_reason === "noted at drop-off", r);
// 2. location moved later
await db.exec(`update bookings set yard='T' where kind='picks' and ref='R1'`);
r = await d("R1"); ok("moving the PICKS location moves the drops yard", r.yard === "T", r);
// 3. office set another yard: left alone
await db.exec(`update bookings set yard='MY' where kind='drops' and ref='R1'`);
await db.exec(`update bookings set yard='GS' where kind='picks' and ref='R1'`);
r = await d("R1"); ok("a yard the office chose isn't overwritten", r.yard === "MY", r);
// 4. note edited: not added twice, charge not changed
await db.exec(`update bookings set note='£25 due, keys in office' where kind='picks' and ref='R1'`);
r = await d("R1"); ok("an edited PICKS note replaces the carried one, charge stays", r.note === "S/D · PICKS: £25 due, keys in office" && r.amt === "20.00", r);
// 5. drops imported first, location set later
await drop("apb", "R2", "KJ26TWY");
await pick("apb", "R2", "KJ26TWY", "", "");
await db.exec(`update bookings set yard='GS' where kind='picks' and ref='R2'`);
r = await d("R2"); ok("location set after the drops import still reaches the drops car", r.yard === "GS" && r.note === "" && r.amt === null, r);
await db.exec(`update bookings set note='£15 key fob' where kind='picks' and ref='R2'`);
r = await d("R2"); ok("money noted later reaches the drops car too", r.amt === "15.00", r);
// 6. no ref: match by reg
await pick("apb", "", "AB12CDE", "MY", "");
await drop("apb", "", "AB12CDE");
r = (await q(`select yard from bookings where kind='drops' and reg='AB12CDE'`))[0]; ok("no ref: matched by reg", r.yard === "MY", r);
// 7. switched off company: nothing
await pick("takeoff", "T1", "XX11XXX", "S", "£30 due");
await drop("takeoff", "T1", "XX11XXX");
r = await d("T1"); ok("companies without Location on PICKS are untouched", r.yard === "" && r.note === "" && r.amt === null, r);
// 8. cleared drops car: untouched
await db.exec(`update bookings set cleared_at=now() where kind='drops' and ref='R2'`);
await db.exec(`update bookings set yard='T' where kind='picks' and ref='R2'`);
r = await d("R2"); ok("a drops car already cleared is left alone", r.yard === "GS", r);
const h = await q(`select action, value from activity where reg='BU15DDE' order by id`);
ok("each carry is in the car's history", h.some((x) => x.action === "YARD" && /from PICKS/.test(x.value)) && h.some((x) => x.action === "CHARGE"), h);
console.log(fails ? fails + " failed" : "all passed");
