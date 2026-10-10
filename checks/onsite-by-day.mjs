// Setup part 82 (cars on site per day counted from the app's own cars) on a throwaway
// in-memory Postgres (PGlite), with just the tables and columns it touches.
//   cd checks && npm install @electric-sql/pglite && node onsite-by-day.mjs
import { PGlite } from "@electric-sql/pglite";
import fs from "fs";
const db = new PGlite();
await db.exec(`
create table companies (id uuid primary key default gen_random_uuid(), slug text, brand jsonb not null default '{}', yards text[] default '{Y,S,T}', time_zone text default 'Europe/London', drops_day_end time not null default '06:00');
create table staff (id uuid primary key default gen_random_uuid(), name text, company_id uuid);
create table sheets (id uuid primary key default gen_random_uuid(), kind text, day date);
create table bookings (id uuid primary key default gen_random_uuid(), company_id uuid, sheet_id uuid, kind text, ref text not null default '', reg text not null default '', name text not null default '',
  drop_at timestamptz, return_at timestamptz, orig_return_at timestamptz, yard text not null default '', yard_before_t text not null default '', note text not null default '', num int, intake text not null default '',
  overstay boolean not null default false, removed_at timestamptz, removed_reason text, removed_by uuid, cleared_at timestamptz,
  charge_agreed numeric(8,2), charge_reason text not null default '', charge_at timestamptz, charge_amount numeric(8,2), charge_method text, charge_by uuid, updated_at timestamptz);
create table activity (id bigint generated always as identity primary key, at timestamptz default now(), company_id uuid, staff_id uuid, staff_name text not null default '', sheet_id uuid, booking_id uuid, reg text, customer text, action text, value text);
create table cur (co uuid);
create function me() returns staff language sql as $$ select s from staff s where s.company_id = (select co from cur) limit 1 $$;
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
for (const part of ["68-carry-from-picks.sql", "73-drops-yard-to-picks.sql", "80-dashboard-drops-days.sql", "81-booked-days.sql", "82-onsite-by-day.sql", "82-onsite-by-day.sql"]) // 82 twice: safe to run twice
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
const T = `((now() at time zone 'Europe/London')::date)`;
const at = (off, hhmm) => `((${T} + ${off} + time '${hhmm}') at time zone 'Europe/London')`;
// a car: drop-off and return as day offsets from today and a time
const car = (ref, d0, t0, d1, t1, extra = "") => db.exec(`insert into bookings(company_id, kind, ref, reg, drop_at, return_at, intake) values (${co("takeoff")}, 'picks', '${ref}', '${ref}', ${at(d0, t0)}, ${at(d1, t1)}, 'Collected')`);
await car("A1", -3, "10:00", 2, "12:00");   // here now, back on day +2
await car("A2", -1, "09:00", 0, "15:00");   // back today
await car("A3", 1, "08:00", 3, "09:00");    // arrives tomorrow
await car("A4", -2, "10:00", 0, "02:00");   // back at 02:00 today: the previous DROPS day's end... counted out by today's 06:00 boundary
await db.exec(`insert into bookings(company_id, kind, ref, reg, drop_at, return_at, removed_at) values (${co("takeoff")}, 'picks', 'GONE', 'GONE', ${at(-1, "10:00")}, ${at(5, "10:00")}, now())`); // removed: never counted
await db.exec(`insert into bookings(company_id, kind, ref, reg, drop_at, return_at, cleared_at) values (${co("takeoff")}, 'drops', 'A5', 'A5', ${at(-1, "10:00")}, ${at(4, "10:00")}, now())`); // a drops car handed back, no picks car: not counted
await car("A5", -1, "10:00", 4, "10:00");   // its picks car: its drops car is cleared, so it is not counted
await db.exec(`insert into bookings(company_id, kind, ref, reg, drop_at, return_at) values (${co("takeoff")}, 'drops', 'D1', 'D1', ${at(0, "12:00")}, ${at(2, "08:00")})`); // drops car with no picks car yet: counted
const x = (await q(`select owner_dashboard(now() - interval '7 days') x`))[0].x;
const o = x.onsite;
ok("14 days from today's DROPS day", Array.isArray(o) && o.length === 14, o && o.length);
ok("days are consecutive dates", o.every((d, i) => i === 0 || new Date(d.day) - new Date(o[i - 1].day) === 864e5), o.map((d) => d.day));
const t0 = (await q(`select ${T}::text d`))[0].d.slice(0, 10);
const sameDay = (d, h, i, u) => d && d.here === h && d.in === i && d.out === u;
const on = (k) => o.find((d) => d.day === new Date(new Date(t0 + "T12:00:00Z").getTime() + k * 864e5).toISOString().slice(0, 10));
ok("today: A1 and D1 stay the night; D1 arrives, A2 goes", sameDay(on(0), 2, 1, 1), on(0));
ok("tomorrow: A1, A3 and D1 stay the night; A3 arrives", sameDay(on(1), 3, 1, 0), on(1));
ok("day +2: only A3 is left; A1 and D1 go", sameDay(on(2), 1, 0, 2), on(2));
ok("a removed car and a handed-back car are never counted", !JSON.stringify(o).includes("GONE") && on(4).here === 0 && on(3).here === 0, [on(3), on(4)]);
// the same car with a matching picks car is counted once
await db.exec(`insert into bookings(company_id, kind, ref, reg, drop_at, return_at, intake) values (${co("takeoff")}, 'picks', 'D1', 'D1', ${at(0, "12:00")}, ${at(2, "08:00")}, 'Collected')`);
const o2 = (await q(`select owner_dashboard(now() - interval '7 days') x`))[0].x.onsite;
ok("a drops car that now has a picks car is not counted twice", JSON.stringify(o2.map((d) => d.here)) === JSON.stringify(o.map((d) => d.here)), [o.map((d) => d.here), o2.map((d) => d.here)]);
await as("other");
const o3 = (await q(`select owner_dashboard(now() - interval '7 days') x`))[0].x.onsite;
ok("another client sees only its own cars", o3.every((d) => d.here === 0 && d.in === 0), o3[0]);
console.log(fails ? fails + " failed" : "all passed");
