// Setup part 77 (yard colours, owners only) on a throwaway in-memory Postgres
// (PGlite), with just the tables and columns it touches.
//   cd checks && npm install @electric-sql/pglite && node yard-colours.mjs
import { PGlite } from "@electric-sql/pglite";
import fs from "fs";
const db = new PGlite();
await db.exec(`
create table companies (id uuid primary key default gen_random_uuid(), name text, slug text, yards text[] default '{Y,S,T}');
create table staff (id uuid primary key default gen_random_uuid(), company_id uuid, name text, role text);
create table activity (id bigint generated always as identity primary key, at timestamptz default now(), company_id uuid, staff_id uuid, staff_name text not null default '', action text, value text);
create table cur (sid uuid);
create function me() returns staff language sql as $$ select s from staff s where id = (select sid from cur) $$;
create role anon; create role authenticated;
insert into companies(slug, yards) values ('takeoff', '{NY,S,CP,Y,T}'), ('airport-parking-bay', '{GS,MY,T}');
insert into staff(company_id, name, role) select id, 'Owner', 'owner' from companies where slug = 'airport-parking-bay';
insert into staff(company_id, name, role) select id, 'Manager', 'manager' from companies where slug = 'airport-parking-bay';
`);
for (let i = 0; i < 2; i++) await db.exec(fs.readFileSync(new URL("../setup/77-yard-colours.sql", import.meta.url), "utf8")); // twice: safe to run twice
const q = async (s, a) => (await db.query(s, a)).rows;
const as = (name) => db.exec(`delete from cur; insert into cur select id from staff where name='${name}'`);
let fails = 0; const ok = (n, c, d) => { console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + JSON.stringify(d))); if (!c) fails++; };
const cols = async (slug) => (await q(`select yard_colours c from companies where slug='${slug}'`))[0].c;
const err = async (sql, a) => { try { await db.query(sql, a); return ""; } catch (e) { return e.message; } };

ok("Airport Parking Bay starts with MY green, GS orange, T yellow", JSON.stringify(await cols("airport-parking-bay")) === JSON.stringify({ T: "#FBC02D", GS: "#EF6C00", MY: "#2E7D32" }), await cols("airport-parking-bay"));
ok("other companies start with none", JSON.stringify(await cols("takeoff")) === "{}");
await as("Owner");
const r = (await q(`select set_yard_colours($1) r`, [{ my: "#00aa00", GS: "", T: " #ffee00 " }]))[0].r;
ok("the owner sets them; blank drops a yard; upper case", JSON.stringify(r.yard_colours) === JSON.stringify({ T: "#FFEE00", MY: "#00AA00" }) && JSON.stringify(await cols("airport-parking-bay")) === JSON.stringify(r.yard_colours), r);
ok("logged as SETTINGS", /Yard colours MY #00AA00, T #FFEE00/.test((await q(`select value from activity order by id desc limit 1`))[0].value));
ok("a yard the company doesn't have is refused", /Not a valid yard/.test(await err(`select set_yard_colours($1)`, [{ NY: "#000000" }])));
ok("a colour that isn't #RRGGBB is refused", /Check the colour/.test(await err(`select set_yard_colours($1)`, [{ MY: "red" }])));
ok("TAKEOFF untouched", JSON.stringify(await cols("takeoff")) === "{}");
await db.exec(fs.readFileSync(new URL("../setup/77-yard-colours.sql", import.meta.url), "utf8"));
ok("running the part again keeps the owner's colours", (await cols("airport-parking-bay")).MY === "#00AA00");
await as("Manager");
ok("a manager can't change them", /Only an owner/.test(await err(`select set_yard_colours($1)`, [{ MY: "#000000" }])));
console.log(fails ? fails + " FAILED" : "all passed");
process.exit(fails ? 1 : 0);
