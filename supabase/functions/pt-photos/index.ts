// Supabase Edge Function: pt-photos
//
// Serves the PT photo link page (public/pt.html) and tidies up old links.
//
//   { action: "view", token }  from the PT page, no sign-in: the token in the
//       link is 18 random bytes, so it can't be guessed. Answers with the reg
//       and short-lived signed URLs for each photo (view and download).
//       Paths starting "r2:" are in Cloudflare R2 (see pt-r2), the rest in
//       Supabase's store.
//   { action: "cleanup" }  from the nightly timer in setup/25-pt-photo-links.sql
//       (x-timer header): deletes links older than 30 days and their photos.
//
// "Verify JWT" must be OFF: PT isn't signed in, and neither is the timer.
import { createClient } from "npm:@supabase/supabase-js@2";
import { AwsClient } from "npm:aws4fetch@1.0.20";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const BUCKET = "pt-photos";
const HOURS = 12;

// Same secrets as pt-r2.
const R2_ACCOUNT = ((Deno.env.get("R2_ACCOUNT_ID") ?? "").match(/[0-9a-f]{32}/i) ?? [""])[0].toLowerCase();
const R2_BUCKET = (Deno.env.get("R2_BUCKET") ?? "").trim();
const r2 = new AwsClient({ accessKeyId: Deno.env.get("R2_ACCESS_KEY_ID") ?? "", secretAccessKey: Deno.env.get("R2_SECRET_ACCESS_KEY") ?? "", service: "s3", region: "auto" });
async function r2Get(key: string, download?: string) {
  const u = new URL(`https://${R2_ACCOUNT}.r2.cloudflarestorage.com/${R2_BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`);
  u.searchParams.set("X-Amz-Expires", String(HOURS * 3600));
  if (download) u.searchParams.set("response-content-disposition", `attachment; filename="${download}"`);
  return (await r2.sign(u.toString(), { method: "GET", aws: { signQuery: true } })).url;
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

  try {
    if (body.action === "view") {
      const token = String(body.token ?? "");
      if (!/^[A-Za-z0-9_-]{22,64}$/.test(token)) return reply(404, { error: "This link isn't right. Ask for it to be sent again." });
      const { data: link, error } = await admin.rpc("pt_link_view", { p_token: token });
      if (error) throw error;
      if (!link) return reply(404, { error: "These photos have expired or the link isn't right." });
      const paths: string[] = link.paths ?? [];
      const reg = String(link.reg || "car").replace(/[^A-Za-z0-9]/g, "");
      const nameOf = (n: number, path: string) => `${reg}-${String(n).padStart(2, "0")}.${(path.match(/\.(\w+)$/) || [, "jpg"])[1]}`;
      const photos: { url: string; download: string; name: string }[] = [];
      let n = 0;
      const inR2 = paths.filter((p) => p.startsWith("r2:")), inStore = paths.filter((p) => !p.startsWith("r2:"));
      if (inR2.length && R2_ACCOUNT && R2_BUCKET) {
        for (const p of inR2) {
          const key = p.slice(3), name = nameOf(++n, key);
          photos.push({ url: await r2Get(key), download: await r2Get(key, name), name });
        }
      }
      for (let i = 0; i < inStore.length; i += 100) {
        const chunk = inStore.slice(i, i + 100);
        const { data: signed, error: e } = await admin.storage.from(BUCKET).createSignedUrls(chunk, HOURS * 3600);
        if (e) throw e;
        for (const [j, s] of (signed ?? []).entries()) {
          if (!s.signedUrl) continue;
          const name = nameOf(++n, chunk[j]);
          photos.push({ url: s.signedUrl, download: s.signedUrl + "&download=" + encodeURIComponent(name), name });
        }
      }
      return reply(200, { reg: link.reg, company: link.company, by: link.by, created_at: link.created_at, expires_at: link.expires_at, photos });
    }

    if (body.action === "cleanup") {
      const { data: ok } = await admin.rpc("timer_secret_ok", { p_secret: req.headers.get("x-timer") ?? "" });
      if (ok !== true) return reply(403, { error: "Not the timer." });
      const { data: gone, error } = await admin.rpc("pt_links_expired");
      if (error) throw error;
      let links = 0, files = 0;
      for (const l of (gone ?? []) as { token: string; paths: string[] }[]) {
        // R2 paths never come here (pt_links_expired leaves them out): R2 deletes its own after 30 days.
        if (l.paths?.length) {
          const { error: e } = await admin.storage.from(BUCKET).remove(l.paths);
          if (e) continue;   // try again tomorrow
          files += l.paths.length;
        }
        await admin.rpc("pt_link_forget", { p_token: l.token });
        links++;
      }
      return reply(200, { links, files });
    }

    return reply(400, { error: "Unknown action." });
  } catch (err) {
    return reply(500, { error: (err as Error).message || String(err) });
  }
});
