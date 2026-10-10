// Setup part 79 (a yard set on DROPS or PICKS is copied to the other car) on a throwaway
// in-memory Postgres (PGlite), with just the tables and columns it touches.
//   cd checks && npm install @electric-sql/pglite && node yard-both-ways.mjs
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
for (const part of ["68-carry-from-picks.sql", "73-drops-yard-to-picks.sql", "79-yard-both-ways.sql", "79-yard-both-ways.sql"]) // 79 twice: safe to run twice
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
const dyard = async (ref) => (await q(`select yard from bookings where kind='drops' and ref='${ref}'`))[0].yard;
const setP = async (ref, y) => db.query(`select set_yard($1, $2)`, [await id("picks", ref), y]);
// 1. DROPS -> PICKS overwrites an existing PICKS location
await pick("takeoff", "A1", "AA11AAA", "S"); await drop("takeoff", "A1", "AA11AAA");
await setYard("A1", "Y");
ok("DROPS yard overwrites the PICKS location", (await pyard("A1")) === "Y");
const h = await q(`select value from activity where action='YARD' and booking_id='${await id("picks", "A1")}'`);
ok("logged as from DROPS", h.some((x) => x.value === "Y · from DROPS"), h);
// 2. PICKS -> DROPS
await pick("takeoff", "B1", "BB22BBB"); await drop("takeoff", "B1", "BB22BBB", "S");
await setP("B1", "Y");
ok("PICKS yard overwrites the DROPS yard", (await dyard("B1")) === "Y");
const h2 = await q(`select value from activity where action='YARD' and booking_id='${await id("drops", "B1")}'`);
ok("logged as from PICKS", h2.some((x) => x.value === "Y · from PICKS"), h2);
// 3. T is never copied, either way
await pick("takeoff", "C1", "CC33CCC", "S"); await drop("takeoff", "C1", "CC33CCC");
await setYard("C1", "T");
ok("T on DROPS isn't copied to PICKS", (await pyard("C1")) === "S");
await pick("takeoff", "C2", "CC44CCC"); await drop("takeoff", "C2", "CC44CCC", "T");
await setP("C2", "Y");
ok("a DROPS car at the terminal (T) keeps T", (await dyard("C2")) === "T");
// 4. clearing is not copied
await setP("B1", "");
ok("clearing a PICKS yard leaves DROPS alone", (await dyard("B1")) === "Y");
// 5. a cleared or removed DROPS car is left alone
await pick("takeoff", "D1", "DD55DDD"); await drop("takeoff", "D1", "DD55DDD", "S");
await db.exec(`update bookings set cleared_at=now() where kind='drops' and ref='D1'`);
await setP("D1", "Y");
ok("a cleared DROPS car isn't changed", (await dyard("D1")) === "S");
// 6. no ref: matched by reg
await pick("takeoff", "", "EE66EEE"); await drop("takeoff", "", "EE66EEE", "S");
await db.query(`select set_yard($1, 'Y')`, [(await q(`select id from bookings where kind='picks' and reg='EE66EEE'`))[0].id]);
ok("no ref: matched by reg", (await q(`select yard from bookings where kind='drops' and reg='EE66EEE'`))[0].yard === "Y");
// 7. same yard again: no extra history line
const before = (await q(`select count(*)::int n from activity`))[0].n;
await setYard("A1", "Y");
const after = (await q(`select count(*)::int n from activity`))[0].n;
ok("same yard again adds only the one line on the car it was set on", after - before === 1, { before, after });
// 8. client without Location on PICKS: untouched
await as("other");
await pick("other", "E1", "GG77GGG", "S"); await drop("other", "E1", "GG77GGG", "S");
await setYard("E1", "Y");
ok("clients without Location on PICKS: DROPS yard not copied", (await pyard("E1")) === "S");
await setP("E1", "T"); await db.exec(`update bookings set yard='S' where kind='drops' and ref='E1'`);
await setP("E1", "Y");
ok("clients without Location on PICKS: PICKS yard not copied", (await dyard("E1")) === "S");
console.log(fails ? fails + " failed" : "all passed");
