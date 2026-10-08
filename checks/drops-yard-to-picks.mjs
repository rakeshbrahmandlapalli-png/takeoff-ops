// Setup part 73 (keys marked on DROPS count on the dashboard) on a throwaway
// in-memory Postgres (PGlite), with just the tables and columns it touches.
//   cd checks && npm install @electric-sql/pglite && node drops-yard-to-picks.mjs
import { PGlite } from "@electric-sql/pglite";
import fs from "fs";
const db = new PGlite();
await db.exec(`
create table companies (id uuid primary key default gen_random_uuid(), slug text, brand jsonb not null default '{}', yards text[] default '{Y,S,T}', time_zone text default 'Europe/London');
create table staff (id uuid primary key default gen_random_uuid(), name text);
create table sheets (id uuid primary key default gen_random_uuid(), kind text, day date);
create table bookings (id uuid primary key default gen_random_uuid(), company_id uuid, sheet_id uuid, kind text, ref text not null default '', reg text not null default '', name text not null default '',
  drop_at timestamptz, return_at timestamptz, orig_return_at timestamptz, yard text not null default '', yard_before_t text not null default '', note text not null default '', num int, intake text not null default '',
  overstay boolean not null default false, removed_at timestamptz, removed_reason text, removed_by uuid, cleared_at timestamptz,
  charge_agreed numeric(8,2), charge_reason text not null default '', charge_at timestamptz, charge_amount numeric(8,2), charge_method text, charge_by uuid, updated_at timestamptz);
create table activity (id bigint generated always as identity primary key, at timestamptz default now(), company_id uuid, staff_id uuid, staff_name text not null default '', sheet_id uuid, booking_id uuid, reg text, customer text, action text, value text);
create table cur (co uuid);
create function me() returns staff language sql as $$ select null::staff $$;
create function my_company() returns uuid language sql as $$ select co from cur $$;
create function can(p text) returns boolean language sql as $$ select true $$;
create or replace function booking_for_update(p_id uuid) returns bookings language plpgsql as $$
declare b bookings;
begin
  select * into b from bookings where id = p_id and company_id = my_company() for update;
  if not found then raise exception 'That car is not on your board.'; end if;
  return b;
end; $$;
create or replace function log_activity(p_booking bookings, p_action text, p_value text)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into activity(company_id, sheet_id, booking_id, reg, customer, action, value)
  values (p_booking.company_id, p_booking.sheet_id, p_booking.id, p_booking.reg, p_booking.name, p_action, coalesce(p_value, ''));
end; $$;
create role anon; create role authenticated;
insert into companies(slug, brand) values ('takeoff', '{"picks_yard": true}'), ('other', '{}');
`);
for (const part of ["68-carry-from-picks.sql", "73-drops-yard-to-picks.sql", "73-drops-yard-to-picks.sql"]) // 73 twice: safe to run twice
  await db.exec(fs.readFileSync(new URL("../setup/" + part, import.meta.url), "utf8"));
const q = async (s) => (await db.query(s)).rows;
const co = (slug) => `(select id from companies where slug='${slug}')`;
const as = (slug) => db.exec(`delete from cur; insert into cur select id from companies where slug='${slug}'`);
let fails = 0; const ok = (n, c, d) => { console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + JSON.stringify(d))); if (!c) fails++; };
const pick = (slug, ref, reg, yard = "", intake = "Collected") => db.exec(`insert into bookings(company_id, kind, ref, reg, drop_at, return_at, yard, intake) values (${co(slug)}, 'picks', '${ref}', '${reg}', now() - interval '3 days', now() + interval '2 days', '${yard}', '${intake}')`);
const drop = (slug, ref, reg, yard = "") => db.exec(`insert into bookings(company_id, kind, ref, reg, drop_at, return_at, yard) values (${co(slug)}, 'drops', '${ref}', '${reg}', now() - interval '3 days', now() + interval '2 days', '${yard}')`);
const id = async (kind, ref) => (await q(`select id from bookings where kind='${kind}' and ref='${ref}'`))[0].id;
const setYard = async (ref, y) => db.query(`select set_yard($1, $2)`, [await id("drops", ref), y]);
const pyard = async (ref) => (await q(`select yard from bookings where kind='picks' and ref='${ref}'`))[0].yard;
const dash = async () => (await q(`select owner_dashboard(now() - interval '7 days') d`))[0].d.parked;
const yardN = (p, y) => (p.yards.find((x) => x.yard === y) || { n: 0 }).n;

await as("takeoff");
// 1. dashboard: a car with no PICKS location counts under its DROPS yard
await pick("takeoff", "A1", "AA11AAA");             // dropped before marking started
await drop("takeoff", "A1", "AA11AAA", "Y");        // the office marked it NB on DROPS
await pick("takeoff", "A2", "BB22BBB", "S");        // marked on PICKS
await drop("takeoff", "A2", "BB22BBB");
await pick("takeoff", "A3", "CC33CCC");             // marked nowhere
let p = await dash();
ok("no PICKS location: counted under the DROPS yard", yardN(p, "Y") === 1, p.yards);
ok("PICKS location still counted", yardN(p, "S") >= 1, p.yards);
ok("marked nowhere: still No yard yet", yardN(p, "") === 1 && p.total === 3, p);
// 2. the PICKS location wins over a different DROPS yard
await db.exec(`update bookings set yard='T' where kind='drops' and ref='A2'`);
p = await dash(); ok("PICKS location wins on the dashboard", yardN(p, "S") === 1 && yardN(p, "T") === 0, p.yards);
// 3. cleared DROPS car: off the count
await db.exec(`update bookings set cleared_at=now() where kind='drops' and ref='A1'`);
p = await dash(); ok("a cleared car leaves the count", yardN(p, "Y") === 0 && p.total === 2, p);

// 4. set_yard on DROPS fills in the empty PICKS location
await pick("takeoff", "B1", "DD44DDD");
await drop("takeoff", "B1", "DD44DDD");
await setYard("B1", "S");
ok("office sets S on DROPS: PICKS car takes S", (await pyard("B1")) === "S");
const h = await q(`select value from activity where action='YARD' and booking_id='${await id("picks", "B1")}'`);
ok("logged on the PICKS car as from DROPS", h.some((x) => x.value === "S · from DROPS"), h);
ok("DROPS yard unchanged by the round trip", (await q(`select yard from bookings where kind='drops' and ref='B1'`))[0].yard === "S");
// 5. a PICKS location already set is never changed
await setYard("B1", "Y");
ok("PICKS location already set: left alone", (await pyard("B1")) === "S");
// 6. T (terminal) isn't copied
await pick("takeoff", "B2", "EE55EEE");
await drop("takeoff", "B2", "EE55EEE");
await setYard("B2", "T");
ok("T on DROPS isn't copied to PICKS", (await pyard("B2")) === "");
// 7. no ref: matched by reg
await pick("takeoff", "", "FF66FFF");
await drop("takeoff", "", "FF66FFF");
await db.query(`select set_yard($1, 'Y')`, [(await q(`select id from bookings where kind='drops' and reg='FF66FFF'`))[0].id]);
ok("no ref: matched by reg", (await q(`select yard from bookings where kind='picks' and reg='FF66FFF'`))[0].yard === "Y");
// 8. client without Location on PICKS: untouched
await as("other");
await pick("other", "C1", "GG77GGG");
await drop("other", "C1", "GG77GGG");
await setYard("C1", "S");
ok("clients without Location on PICKS: PICKS untouched", (await pyard("C1")) === "");
// 9. clearing a DROPS yard leaves PICKS alone
await as("takeoff");
await setYard("B1", "");
ok("clearing the DROPS yard leaves PICKS alone", (await pyard("B1")) === "S");
console.log(fails ? fails + " failed" : "all passed");
