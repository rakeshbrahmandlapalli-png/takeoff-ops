// Setup part 69 (desk bookings on PICKS, docket photos) on a throwaway in-memory
// Postgres (PGlite), with stand-ins for Supabase (storage, can(), me()).
//   cd checks && npm install @electric-sql/pglite && node desk-booking.mjs
import { PGlite } from "@electric-sql/pglite";
import fs from "fs";
const db = new PGlite();
await db.exec(`
create role anon; create role authenticated; create role service_role;
create schema storage;
create table storage.objects (id serial, bucket_id text, name text, created_at timestamptz default now(), metadata jsonb default '{}');
create function storage.foldername(n text) returns text[] language sql as $$ select (string_to_array(n, '/'))[1:array_length(string_to_array(n,'/'),1)-1] $$;
create table companies (id uuid primary key default gen_random_uuid(), slug text, brand jsonb not null default '{}', yards text[] default '{GS,MY,T}', time_zone text default 'Europe/London');
create table staff (id uuid primary key default gen_random_uuid(), name text, role text, company_id uuid);
create table sheets (id uuid primary key default gen_random_uuid(), company_id uuid, kind text, day date);
create table bookings (id uuid primary key default gen_random_uuid(), company_id uuid, sheet_id uuid, kind text, ref text not null default '', reg text not null default '', name text not null default '', phone text not null default '', make text not null default '',
  drop_at timestamptz, return_at timestamptz, flight text not null default '', yard text not null default '', note text not null default '', num int,
  pick_called text not null default '', pick_called_at timestamptz, intake text not null default '', intake_at timestamptz, intake_by uuid, updated_at timestamptz);
create table activity (id bigint generated always as identity primary key, company_id uuid, staff_id uuid, staff_name text not null default '', sheet_id uuid, booking_id uuid, reg text, customer text, action text, value text);
create table pt_links (token text, paths text[], created_at timestamptz default now(), expires_at timestamptz default now() + interval '30 days');
insert into companies(slug) values ('apb');
insert into staff(name, role, company_id) select 'TERRY', 'terminal', id from companies;
insert into sheets(company_id, kind, day) select id, 'picks', current_date from companies;
insert into sheets(company_id, kind, day) select id, 'drops', current_date from companies;
create table perm (k text); insert into perm values ('intake');
create function me() returns staff language sql as $$ select * from staff limit 1 $$;
create function my_company() returns uuid language sql as $$ select id from companies limit 1 $$;
create function can(p text) returns boolean language sql as $$ select exists(select 1 from perm where k = p) $$;
create function booking_for_update(p uuid) returns bookings language sql as $$ select * from bookings where id = p $$;
create function log_activity(b bookings, a text, v text) returns void language sql as $$ insert into activity(company_id, booking_id, reg, action, value) values (b.company_id, b.id, b.reg, a, v) $$;
`);
const sql = fs.readFileSync(new URL("../setup/69-desk-booking-docket.sql", import.meta.url), "utf8").replace(/create policy[\s\S]*?;\n/, "").replace(/drop policy[^\n]*\n/, "");
await db.exec(sql); await db.exec(sql);
const q = async (s, p) => (await db.query(s, p)).rows;
let f = 0; const ok = (n, c, d) => { console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : " -> " + JSON.stringify(d))); if (!c) f++; };
const ps = (await q("select id from sheets where kind='picks'"))[0].id, ds = (await q("select id from sheets where kind='drops'"))[0].id;
let b = (await q("select (add_booking($1, $2)).*", [ps, JSON.stringify({ reg: "bu15 dde", name: "MR DESK", desk: true, taken_in: true, yard: "GS", return_local: "2026-10-11 05:15", drop_local: "2026-10-07 09:00" })]))[0];
ok("terminal can add a desk booking on PICKS", b.reg === "BU15 DDE" && b.pick_called === "New Booking" && b.intake === "Collected" && b.yard === "GS", b);
let err = ""; try { await q("select add_booking($1, $2)", [ds, JSON.stringify({ reg: "X1" })]); } catch (e) { err = e.message; }
ok("terminal can't add to DROPS", /Only the office/.test(err), err);
b = (await q("select (add_booking($1, $2)).*", [ps, JSON.stringify({ reg: "AB12CDE", desk: true, taken_in: false })]))[0];
ok("not taken in: stays LEFT, still NEW BOOKING", b.intake === "" && b.pick_called === "New Booking", b);
const co = (await q("select id from companies"))[0].id;
const good = co + "/docs/" + b.id + "/1700000000000.jpg";
b = (await q("select (set_doc($1, $2)).*", [b.id, good]))[0];
ok("set_doc records the photo", b.doc_path === good && b.doc_at, b);
err = ""; try { await q("select set_doc($1, $2)", [b.id, co + "/docs/someoneelse/1.jpg"]); } catch (e) { err = e.message; }
ok("set_doc refuses another car's path", /not this car/.test(err), err);
await db.exec(`insert into storage.objects(bucket_id, name, created_at) values ('pt-photos', '${co}/docs/x/1.jpg', now() - interval '91 days'), ('pt-photos', '${co}/docs/y/2.jpg', now() - interval '2 days'), ('pt-photos', '${co}/bk1/tok/1.jpg', now() - interval '2 days')`);
const gone = (await q("select * from pt_links_expired()")).flatMap((r) => r.paths || []);
ok("old dockets swept at 90 days, recent ones kept, stray PT photos still swept", gone.includes(co + "/docs/x/1.jpg") && !gone.includes(co + "/docs/y/2.jpg") && gone.includes(co + "/bk1/tok/1.jpg"), gone);
console.log(f ? f + " failed" : "all passed");
