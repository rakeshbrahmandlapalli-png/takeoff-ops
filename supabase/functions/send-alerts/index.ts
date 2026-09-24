// Supabase Edge Function: send-alerts
//
// Phone notifications (web push) and Discord messages for:
//   DROPS  CALLED / OVERSTAY on a car no driver has been SENT to yet
//          COMPLAINT
//          flight CANCELLED on a car not yet handed back
//   PICKS  RTC
//
// Called two ways (POST JSON):
//   { type: "booking", id }  by the database trigger in setup/04-alerts.sql.
//       Nothing in the message is trusted except which booking to look at:
//       the booking is re-read here, an alert only goes if it is really due
//       and recent, and alert_log makes sure each one goes out once.
//   { type: "test", discord? }  by the "Send a test" buttons, with a sign-in.
//       Sends to the caller's own phones; Discord only for owner/manager.
//
// Secrets (Edge Functions → Secrets):
//   VAPID_PUBLIC_KEY   same value as VAPID_PUBLIC_KEY in public/app.js
//   VAPID_PRIVATE_KEY  never in a page, a file in the repo or a chat
// "Verify JWT" must be OFF: the database calls it without a sign-in.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const db = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
webpush.setVapidDetails("https://takeoff-ops.vercel.app", Deno.env.get("VAPID_PUBLIC_KEY")!, Deno.env.get("VAPID_PRIVATE_KEY")!);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const TZ = "Europe/London";
const time = (iso: string | null) => iso ? new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : "";
const FRESH_MIN = 30;   // a tap older than this is history, not news

type Kind = "drops" | "picks" | "flights";
type Note = { title: string; body: string; url: string; tag: string };

async function once(key: string) {
  const { error } = await db.from("alert_log").insert({ key });
  if (!error) return true;
  if (error.code === "23505") return false;
  throw error;
}

async function pushTo(staffIds: string[], kind: Kind, note: Note) {
  if (!staffIds.length) return 0;
  const { data: prefs } = await db.from("alert_prefs").select("*").in("staff_id", staffIds);
  const off = new Set((prefs ?? []).filter((p) => p[kind] === false).map((p) => p.staff_id));
  const wanted = staffIds.filter((id) => !off.has(id));
  if (!wanted.length) return 0;
  const { data: subs } = await db.from("push_subscriptions").select("id, endpoint, p256dh, auth").in("staff_id", wanted);
  let sent = 0;
  await Promise.all((subs ?? []).map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(note), { TTL: 2 * 3600, urgency: "high" });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await db.from("push_subscriptions").delete().eq("id", s.id);   // phone gone
      else console.error("push failed", code, (e as { body?: string }).body ?? String(e));
    }
  }));
  return sent;
}

async function discord(companyId: string, channel: "drops" | "picks", title: string, body: string) {
  const { data: d } = await db.rpc("alert_discord", { p_company: companyId });
  const url = d?.[channel + "_url"];
  if (!url) return false;
  const mention = String(d.mention ?? "").trim();
  // A Discord problem must not stop the phone alerts or the next alert.
  let res: Response;
  try { res = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    // Without allowed_mentions Discord posts but pings nobody.
    body: JSON.stringify({ content: (mention ? mention + " " : "") + `**${title}**\n${body}`, allowed_mentions: { parse: ["everyone", "roles", "users"] } }),
  }); } catch (e) { console.error("discord failed", String(e)); return false; }
  if (!res.ok) console.error("discord failed", res.status, (await res.text()).slice(0, 200));
  return res.ok;
}

async function onBooking(id: string) {
  const { data: b } = await db.from("bookings").select("*, sheets(day)").eq("id", id).maybeSingle();
  if (!b) return { sent: 0 };
  const { data: people } = await db.from("staff").select("id, name").eq("company_id", b.company_id).eq("active", true);
  const nameOf = (sid: string | null) => (people ?? []).find((p) => p.id === sid)?.name ?? "";
  const everyoneBut = (sid: string | null) => (people ?? []).map((p) => p.id).filter((x) => x !== sid);
  const fresh = (iso: string | null) => !!iso && Date.now() - new Date(iso).getTime() < FRESH_MIN * 60000;

  const car = `${b.num ? "#" + b.num + " · " : ""}${b.reg || "no reg"}${b.yard ? " (" + b.yard + ")" : ""}`;
  const who = b.name || "Customer";
  const flightLine = b.flight ? `${b.flight} · due ${b.est_time && b.est_time !== "DELAY" ? b.est_time : b.sched_time || time(b.return_at)}` : `back ${time(b.return_at)}`;
  const alerts: { key: string; kind: Kind; channel: "drops" | "picks"; label: string; at: string; by: string | null }[] = [];

  if (b.kind === "drops" && b.called_at && !b.sent_at && !b.cleared_at && fresh(b.called_at)) {
    alerts.push({ key: `called:${b.id}:${b.called_at}`, kind: "drops", channel: "drops", label: b.called_word === "Overstay" ? "OVERSTAY" : "CALLED", at: b.called_at, by: b.called_by });
  }
  if (b.kind === "drops" && b.clear_word === "COMPLAINT" && fresh(b.cleared_at)) {
    alerts.push({ key: `complaint:${b.id}:${b.cleared_at}`, kind: "drops", channel: "drops", label: "🚨 COMPLAINT", at: b.cleared_at, by: b.cleared_by });
  }
  if (b.kind === "picks" && b.intake === "RTC" && fresh(b.intake_at)) {
    alerts.push({ key: `rtc:${b.id}:${b.intake_at}`, kind: "picks", channel: "picks", label: "RTC", at: b.intake_at, by: b.intake_by });
  }
  if (b.kind === "drops" && b.flight_status === "cancelled" && !b.cleared_at) {
    alerts.push({ key: `cancel:${b.id}:${b.flight}:${b.sheets?.day ?? ""}`, kind: "flights", channel: "drops", label: "✈️ FLIGHT CANCELLED", at: new Date().toISOString(), by: null });
  }

  let sent = 0;
  for (const a of alerts) {
    if (!(await once(a.key))) continue;
    const byName = nameOf(a.by);
    const title = `${a.label}: ${car} — ${who}`;
    const body = a.kind === "flights"
      ? `${b.flight} has been cancelled by the airline. The customer may not be coming back as booked.`
      : `${a.label.replace(/^\S+ /, "")} at ${time(a.at)}${byName ? " by " + byName : ""} · ${a.kind === "picks" ? "drop-off " + time(b.drop_at) : flightLine}${b.note ? " · " + b.note.replace(/^!\s*/, "") : ""}`;
    sent += await pushTo(everyoneBut(a.by), a.kind, { title, body, url: "/", tag: `${a.kind}-${b.id}` });
    await discord(b.company_id, a.channel, title, body);
  }
  return { sent };
}

async function onTest(req: Request, body: Record<string, unknown>) {
  const asCaller = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, {
    auth: { persistSession: false }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: me } = await asCaller.rpc("me");
  if (!me?.id) return reply(401, { error: "Sign in again." });
  const sent = await pushTo([me.id], "drops", { title: "TakeOff test", body: `Notifications work on this phone, ${me.name}.`, url: "/", tag: "test" });
  const result: Record<string, unknown> = { sent };
  if (body.discord) {
    const { data: allowed } = await asCaller.rpc("can", { p_action: "settings" });
    if (allowed !== true) return reply(403, { error: "Only an owner or manager can test Discord." });
    const text = `Test from the TakeOff app by ${me.name}. Alerts will arrive in this channel.`;
    result.drops = await discord(me.company_id, "drops", "TakeOff test (DROPS channel)", text);
    result.picks = await discord(me.company_id, "picks", "TakeOff test (PICKS channel)", text);
  }
  return reply(200, result);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "POST only." });
  let msg: Record<string, unknown>;
  try { msg = await req.json(); } catch { return reply(400, { error: "Bad request." }); }
  try {
    if (msg.type === "booking" && /^[0-9a-f-]{36}$/i.test(String(msg.id))) return reply(200, await onBooking(String(msg.id)));
    if (msg.type === "test") return await onTest(req, msg);
    return reply(400, { error: "Unknown message." });
  } catch (e) {
    console.error(e);
    return reply(500, { error: String((e as Error).message ?? e) });
  }
});
