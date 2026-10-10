// Setup part 80 (the dashboard groups return days as DROPS days: 06:00 to 06:00) on a throwaway
// in-memory Postgres (PGlite), with just the tables and columns it touches.
//   cd checks && npm install @electric-sql/pglite && node dashboard-drops-days.mjs
import { PGlite } from "@electric-sql/pglite";
import fs from "fs";
const db = new PGlite();
await db.exec(`
create table companies (id uuid primary key default gen_random_uuid(), slug text, brand jsonb not null default '{}', yards text[] default '{Y,S,T}', time_zone text default 'Europe/London', drops_day_end time not null default '06:00');
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
for (const part of ["68-carry-from-picks.sql", "73-drops-yard-to-picks.sql", "80-dashboard-drops-days.sql", "80-dashboard-drops-days.sql"]) // 80 twice: safe to run twice
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
const tom = `((now() at time zone 'Europe/London')::date + 1)`;
const at = (hhmm) => `((${tom} + time '${hhmm}') at time zone 'Europe/London')`;
const car = (ref, hhmm, yard = "") => db.exec(`insert into bookings(company_id, kind, ref, reg, drop_at, return_at, yard, intake) values (${co("takeoff")}, 'picks', '${ref}', '${ref}', now() - interval '3 days', ${at(hhmm)}, '${yard}', 'Collected')`);
await car("A1", "02:00", "Y");   // small hours: still the night before's DROPS day
await car("A2", "06:00", "Y");   // 06:00 exactly is the end of the previous DROPS day
await car("A3", "06:01", "S");   // first minute of the new DROPS day
await car("A4", "23:30", "S");
const d = (await q(`select (select (${tom})::text) k, owner_dashboard(now() - interval '7 days') x`))[0];
const key = d.k.slice(0, 10), prev = new Date(new Date(key + "T12:00:00Z").getTime() - 864e5).toISOString().slice(0, 10);
const days = d.x.parked.days, n = (k) => (days.find((x) => x.day === k) || { n: 0 }).n;
ok("02:00 and 06:00 count on the day before", n(prev) === 2, days);
ok("06:01 and 23:30 count on that day", n(key) === 2, days);
const ydays = (y) => (d.x.parked.yards.find((x) => x.yard === y) || { days: [] }).days;
ok("per-yard days use the same split", ydays("Y").length === 1 && ydays("Y")[0].day === prev && ydays("Y")[0].n === 2 && ydays("S").length === 1 && ydays("S")[0].day === key && ydays("S")[0].n === 2, d.x.parked.yards);
ok("total unchanged", d.x.parked.total === 4, d.x.parked);
// a client with a later day end (08:00): 07:00 belongs to the day before
await db.exec(`update companies set drops_day_end = '08:00' where slug='takeoff'`);
const d2 = (await q(`select owner_dashboard(now() - interval '7 days') x`))[0].x.parked.days;
ok("a client's own day end is used", (d2.find((x) => x.day === prev) || { n: 0 }).n === 3 && (d2.find((x) => x.day === key) || { n: 0 }).n === 1, d2);
await db.exec(`update companies set drops_day_end = '06:00' where slug='takeoff'`);
await db.exec(`insert into bookings(company_id, kind, ref, reg, name, drop_at, return_at, yard, intake) values (${co("takeoff")}, 'picks', 'L1', 'LATE1', 'Old', now() - interval '5 days', now() - interval '2 days 3 hours', 'S', 'Collected'), (${co("takeoff")}, 'picks', 'L2', 'LATE2', 'New', now() - interval '3 days', now() - interval '1 hour', '', 'Collected')`);
const pk = (await q(`select owner_dashboard(now() - interval '7 days') x`))[0].x.parked;
ok("late cars listed, oldest first", pk.late === 2 && pk.late_cars.length === 2 && pk.late_cars[0].reg === "LATE1" && pk.late_cars[0].yard === "S", pk);
console.log(fails ? fails + " failed" : "all passed");
