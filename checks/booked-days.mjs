// Setup part 81 (cars on site per day pasted from the booking report) on a throwaway
// in-memory Postgres (PGlite), with just the tables and columns it touches.
//   cd checks && npm install @electric-sql/pglite && node booked-days.mjs
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
for (const part of ["68-carry-from-picks.sql", "73-drops-yard-to-picks.sql", "80-dashboard-drops-days.sql", "81-booked-days.sql", "81-booked-days.sql"]) // 81 twice: safe to run twice
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
await db.exec(`insert into staff(name, company_id) values ('Owner', ${co("takeoff")}), ('Other', ${co("other")})`);
const set = (o) => db.query(`select set_booked_days($1::jsonb) r`, [JSON.stringify(o)]);
const fails_ = async (o) => { try { await set(o); return false; } catch (e) { return String(e.message); } };
await set({ "2026-10-10": 638, "2026-10-11": 651, "2026-10-12": 523 });
let d = (await q(`select owner_dashboard(now() - interval '7 days') x`))[0].x;
ok("saved and returned by the dashboard", d.booked["2026-10-11"] === 651 && Object.keys(d.booked).length === 3 && d.booked_at, d.booked);
ok("the rest of the dashboard still there", d.parked && typeof d.parked.total === "number" && Array.isArray(d.added));
await set({ "2026-10-20": 400 });
d = (await q(`select owner_dashboard(now() - interval '7 days') x`))[0].x;
ok("a new paste replaces the old list", Object.keys(d.booked).length === 1 && d.booked["2026-10-20"] === 400, d.booked);
ok("a bad date is refused", /Not a date/.test(await fails_({ "2026-13-40": 5 })));
ok("text instead of a date is refused", /Not a date/.test(await fails_({ "tomorrow": 5 })));
ok("a bad total is refused", /Check the total/.test(await fails_({ "2026-10-10": "abc" })));
ok("a huge total is refused", /Check the total/.test(await fails_({ "2026-10-10": 999999999 })));
ok("not an object is refused", /Nothing to save/.test(await fails_([1, 2])));
const act = await q(`select value from activity where action='SETTINGS'`);
ok("logged", act.length >= 2 && /pasted/.test(act[0].value), act);
await as("other");
d = (await q(`select owner_dashboard(now() - interval '7 days') x`))[0].x;
ok("another client sees none of it", Object.keys(d.booked).length === 0 && d.booked_at === null, d.booked);
console.log(fails ? fails + " failed" : "all passed");
