// Setup part 78 (return flight and changed return time typed on a PICKS car carry to DROPS) on a
// throwaway in-memory Postgres (PGlite), with just the tables and columns it touches.
//   cd checks && npm install @electric-sql/pglite && node picks-return-flight.mjs
import { PGlite } from "@electric-sql/pglite";
import fs from "fs";
const db = new PGlite();
await db.exec(`
create table companies (id uuid primary key default gen_random_uuid(), slug text, time_zone text not null default 'Europe/London');
create table staff (id uuid primary key default gen_random_uuid(), name text);
create table bookings (id uuid primary key default gen_random_uuid(), company_id uuid, sheet_id uuid, kind text, ref text not null default '', reg text not null default '', name text not null default '',
  drop_at timestamptz, return_at timestamptz, flight text not null default '', sched_at timestamptz, sched_time text not null default '', est_at timestamptz, est_time text not null default '',
  flight_status text not null default '', flight_note text not null default '', flight_checked_at timestamptz, note text not null default '',
  removed_at timestamptz, cleared_at timestamptz, early boolean not null default false, updated_at timestamptz);
create table set_return_calls (id uuid, v text);
create function set_return(p uuid, v text) returns bookings language plpgsql as $$ declare b bookings; begin insert into set_return_calls values (p, v); select * into b from bookings where id = p; return b; end; $$;
create table activity (id bigint generated always as identity primary key, company_id uuid, staff_id uuid, staff_name text not null default '', sheet_id uuid, booking_id uuid, reg text, customer text, action text, value text);
create table perms (a text);
create function me() returns staff language sql as $$ select null::staff $$;
create function can(a text) returns boolean language sql as $$ select exists (select 1 from perms where perms.a = can.a) $$;
create function booking_for_update(p uuid) returns bookings language sql as $$ select * from bookings where id = p $$;
create or replace function log_activity(p_booking bookings, p_action text, p_value text)
returns void language plpgsql security definer set search_path = public as $$
declare s staff := me();
begin
  insert into activity(company_id, staff_id, staff_name, sheet_id, booking_id, reg, customer, action, value)
  values (p_booking.company_id, s.id, coalesce(s.name, ''), p_booking.sheet_id, p_booking.id, p_booking.reg, p_booking.name, p_action, coalesce(p_value, ''));
end; $$;
create role anon; create role authenticated;
insert into companies(slug) values ('takeoff'), ('apb');
insert into perms values ('intake');
`);
const sql = fs.readFileSync(new URL("../setup/78-picks-flight-and-return.sql", import.meta.url), "utf8");
await db.exec(sql);
await db.exec(sql); // safe to run twice
const q = async (s) => (await db.query(s)).rows;
const co = (slug) => `(select id from companies where slug='${slug}')`;
let fails = 0; const ok = (n, c, d) => { console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + JSON.stringify(d))); if (!c) fails++; };
const pick = (slug, ref, reg, dropAgo = "2 days") => db.exec(`insert into bookings(company_id, kind, ref, reg, drop_at, return_at, note) values (${co(slug)}, 'picks', '${ref}', '${reg}', now() - interval '${dropAgo}', now() + interval '1 day', 'keys in office')`);
const drop = (slug, ref, reg, flight = "") => db.exec(`insert into bookings(company_id, kind, ref, reg, drop_at, return_at, flight) values (${co(slug)}, 'drops', '${ref}', '${reg}', now() - interval '2 days', now() + interval '1 day', '${flight}')`);
const pid = async (ref) => (await q(`select id from bookings where kind='picks' and ref='${ref}'`))[0].id;
const setPick = async (ref, f) => (await q(`select flight from set_pick_flight('${await pid(ref)}', '${f}')`))[0];
const d = async (ref) => (await q(`select flight, note from bookings where kind='drops' and ref='${ref}'`))[0];
const err = async (s) => { try { await db.query(s); return ""; } catch (e) { return e.message; } };

// 1. typed at drop-off, DROPS imported later
await pick("takeoff", "R1", "BU15DDE");
let p = await setPick("R1", "ls 1234");
ok("PICKS flight saved, tidied", p.flight === "LS1234", p);
await drop("takeoff", "R1", "BU15DDE");
let r = await d("R1");
ok("DROPS car takes the PICKS flight", r.flight === "LS1234", r);
ok("notes are left as they are", r.note === "" && (await q(`select note from bookings where kind='picks' and ref='R1'`))[0].note === "keys in office");
const h = await q(`select action, value from activity where reg='BU15DDE' and action='FLIGHT' order by id`);
ok("logged as FLIGHT on both cars (so imports keep it)", h.length === 2 && h[1].value === "LS1234 · from PICKS", h);
// 2. DROPS already on a sheet with no flight, flight typed after
await pick("takeoff", "R2", "AB12CDE"); await drop("takeoff", "R2", "AB12CDE");
await setPick("R2", "W43451");
ok("an existing DROPS car with no flight takes it", (await d("R2")).flight === "W43451");
// 3. corrected at PICKS: the DROPS car follows
await setPick("R2", "W43452");
ok("a corrected PICKS flight moves the DROPS one too", (await d("R2")).flight === "W43452");
// 4. DROPS has its own flight: kept
await pick("takeoff", "R3", "CD34EFG"); await drop("takeoff", "R3", "CD34EFG", "U22492");
await setPick("R3", "EZY100");
ok("a flight the DROPS car already has is kept", (await d("R3")).flight === "U22492");
// 5. office changed the DROPS flight after the carry: a PICKS change no longer touches it
await db.exec(`update bookings set flight='FR999' where kind='drops' and ref='R2'`);
await setPick("R2", "W43453");
ok("a DROPS flight changed by the office stays", (await d("R2")).flight === "FR999");
// 6. cleared DROPS car: untouched
await pick("takeoff", "R4", "EF56GHI"); await drop("takeoff", "R4", "EF56GHI");
await db.exec(`update bookings set cleared_at=now() where kind='drops' and ref='R4'`);
await setPick("R4", "BA123");
ok("a cleared DROPS car is left alone", (await d("R4")).flight === "");
// 7. other company with the same ref: untouched
await drop("apb", "R5", "ZZ99ZZZ"); await pick("takeoff", "R5", "ZZ99ZZZ"); await setPick("R5", "BA200");
ok("another client's car is never touched", (await d("R5")).flight === "");
// 8. permissions and kinds
await db.exec(`delete from perms`);
ok("needs intake or flights", /Not allowed/.test(await err(`select set_pick_flight('${await pid("R1")}', 'X1')`)));
await db.exec(`insert into perms values ('flights')`);
const did = (await q(`select id from bookings where kind='drops' and ref='R1'`))[0].id;
ok("only PICKS cars", /PICKS/.test(await err(`select set_pick_flight('${did}', 'X1')`)));
ok("too long refused", /flight number/.test(await err(`select set_pick_flight('${await pid("R1")}', 'ABCDEFGHIJK')`)));
// 9. return changed on the PICKS car (office)
await db.exec(`delete from perms; insert into perms values ('import')`);
const when = (await q(`select to_char((now() + interval '3 days') at time zone 'Europe/London', 'YYYY-MM-DD') || ' 07:15' v`))[0].v;
p = (await q(`select to_char(return_at at time zone 'Europe/London', 'YYYY-MM-DD HH24:MI') v from set_pick_return('${await pid("R1")}', '${when}')`))[0];
ok("PICKS return saved", p.v === when, p);
const calls = await q(`select b.ref, s.v from set_return_calls s join bookings b on b.id = s.id`);
ok("its DROPS car gets the same change", calls.length === 1 && calls[0].ref === "R1" && calls[0].v === when, calls);
ok("logged as RETURN CHANGED", (await q(`select 1 from activity where action='RETURN CHANGED' and reg='BU15DDE'`)).length === 1);
await q(`select set_pick_return('${await pid("R1")}', '${when}')`);
ok("unchanged: nothing more", (await q(`select 1 from set_return_calls`)).length === 1);
await q(`select set_pick_return('${await pid("R4")}', '${when}')`);
ok("a cleared DROPS car isn't changed", (await q(`select 1 from set_return_calls`)).length === 1);
ok("before the drop-off refused", /after the drop-off/.test(await err(`select set_pick_return('${await pid("R2")}', '2026-01-01 07:15')`)) || /Check the date/.test(await err(`select set_pick_return('${await pid("R2")}', '2026-01-01 07:15')`)));
ok("bad format refused", /date and the time/.test(await err(`select set_pick_return('${await pid("R2")}', 'tomorrow')`)));
await db.exec(`delete from perms; insert into perms values ('intake')`);
ok("needs import (office)", /Only the office/.test(await err(`select set_pick_return('${await pid("R2")}', '${when}')`)));
console.log(fails ? fails + " failed" : "all passed");
