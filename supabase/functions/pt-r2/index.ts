// Supabase Edge Function: pt-r2
//
// The app's copy of each car's PT photos lives in Cloudflare R2 (10 GB free,
// no download charges), not in Supabase's 1 GB file store. Phones never hold
// an R2 key: this function checks who's asking and hands out short-lived
// signed addresses to upload to (or view) one car's photos.
//
//   { action: "upload", booking, token, names: ["01.jpg", ...] }  signed in,
//       with the "intake" permission, for a car on their own board. Answers
//       { urls: { "01.jpg": "https://...signed PUT..." } }, valid 15 minutes.
//   { action: "selftest" }  x-timer header: puts, reads and deletes a small
//       file, so the set-up can be checked without a phone.
//   { action: "sizes", prefix? }  x-timer header: the files (the first
//       1000) under a folder and their sizes, to check copies came out small.
//
// Objects are named <company>/<booking>/<token>/<NN>.jpg, like Supabase's
// store. R2 deletes them itself after 30 days (bucket lifecycle rule).
// Secrets: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.
// "Verify JWT" must be OFF: the timer has no sign-in; callers are checked here.
import { createClient } from "npm:@supabase/supabase-js@2";
import { AwsClient } from "npm:aws4fetch@1.0.20";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
// The account ID is 32 hex characters; taken out of whatever was pasted (the
// whole S3 endpoint address works too).
const ACCOUNT = ((Deno.env.get("R2_ACCOUNT_ID") ?? "").match(/[0-9a-f]{32}/i) ?? [""])[0].toLowerCase();
const BUCKET = (Deno.env.get("R2_BUCKET") ?? "").trim();
const r2 = new AwsClient({ accessKeyId: Deno.env.get("R2_ACCESS_KEY_ID") ?? "", secretAccessKey: Deno.env.get("R2_SECRET_ACCESS_KEY") ?? "", service: "s3", region: "auto" });
const objectUrl = (key: string) => `https://${ACCOUNT}.r2.cloudflarestorage.com/${BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`;
async function signed(key: string, method: "PUT" | "GET", seconds: number) {
  const u = new URL(objectUrl(key)); u.searchParams.set("X-Amz-Expires", String(seconds));
  const req = await r2.sign(u.toString(), { method, aws: { signQuery: true } });
  return req.url;
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "POST only." });
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return reply(400, { error: "Bad request." }); }
  if (!ACCOUNT || !BUCKET) return reply(503, { error: "Photo store not set up yet." });

  try {
    if (body.action === "selftest") {
      const { data: ok } = await admin.rpc("timer_secret_ok", { p_secret: req.headers.get("x-timer") ?? "" });
      if (ok !== true) return reply(403, { error: "Not the timer." });
      const key = "selftest/" + crypto.randomUUID() + ".txt", text = "takeoff selftest " + new Date().toISOString();
      const put = await fetch(await signed(key, "PUT", 60), { method: "PUT", body: text, headers: { "content-type": "text/plain" } });
      const got = put.ok ? await fetch(await signed(key, "GET", 60)) : null;
      const back = got && got.ok ? await got.text() : "";
      const del = await r2.fetch(objectUrl(key), { method: "DELETE" });
      return reply(200, { put: put.status, get: got?.status ?? null, same: back === text, delete: del.status, bucket: BUCKET });
    }

    if (body.action === "sizes") {
      const { data: ok } = await admin.rpc("timer_secret_ok", { p_secret: req.headers.get("x-timer") ?? "" });
      if (ok !== true) return reply(403, { error: "Not the timer." });
      const u = new URL(`https://${ACCOUNT}.r2.cloudflarestorage.com/${BUCKET}`);
      u.searchParams.set("list-type", "2"); u.searchParams.set("prefix", String(body.prefix ?? ""));
      const res = await r2.fetch(u.toString());
      const xml = await res.text();
      if (!res.ok) return reply(502, { error: "R2 said " + res.status });
      const files = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((m) => ({
        key: (m[1].match(/<Key>(.*?)<\/Key>/) ?? [])[1] ?? "", size: +((m[1].match(/<Size>(\d+)<\/Size>/) ?? [])[1] ?? 0),
        at: (m[1].match(/<LastModified>(.*?)<\/LastModified>/) ?? [])[1] ?? "",
      }));
      const bytes = files.reduce((a, f) => a + f.size, 0);
      return reply(200, { files: files.length, mb: Math.round(bytes / 1048576 * 10) / 10, biggest: Math.max(0, ...files.map((f) => f.size)), list: files.slice(-200) });
    }

    if (body.action === "upload") {
      const asCaller = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, {
        auth: { persistSession: false }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
      });
      const [{ data: companyId }, { data: allowed }] = await Promise.all([asCaller.rpc("my_company"), asCaller.rpc("can", { p_action: "intake" })]);
      if (!companyId) return reply(401, { error: "Sign in again." });
      if (allowed !== true) return reply(403, { error: "Not allowed for your role." });
      const booking = String(body.booking ?? ""), token = String(body.token ?? "");
      const names = Array.isArray(body.names) ? body.names.map(String) : [];
      if (!/^[0-9a-f-]{36}$/i.test(booking) || !/^[A-Za-z0-9_-]{22,64}$/.test(token) || !names.length || names.length > 60
        || names.some((n) => !/^\d{2,3}\.jpg$/.test(n))) return reply(400, { error: "Bad request." });
      const { data: b } = await admin.from("bookings").select("id").eq("id", booking).eq("company_id", companyId).maybeSingle();
      if (!b) return reply(404, { error: "That car is not on your board." });
      const urls: Record<string, string> = {};
      for (const n of names) urls[n] = await signed(`${companyId}/${booking}/${token}/${n}`, "PUT", 900);
      return reply(200, { urls });
    }

    return reply(400, { error: "Unknown action." });
  } catch (err) {
    return reply(500, { error: (err as Error).message || String(err) });
  }
});
