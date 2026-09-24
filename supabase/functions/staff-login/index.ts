// Supabase Edge Function: staff-login
//
// Signs a person in with their personal link + 4-digit PIN. Drivers have no
// email address to use, so behind the scenes each person has an ordinary
// Supabase login; once the link and PIN check out, this function issues a
// one-time sign-in token for it, and the app exchanges that for a session
// (supabase.auth.verifyOtp({ type: "magiclink", token_hash })).
//
// "Verify JWT" must be OFF: the person isn't signed in yet.
// Wrong PINs are counted in the database: five in a row lock that person for
// 15 minutes. The link token is 32 random bytes, so it can't be guessed.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function sha256Hex(text: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "POST only." });

  let body: { token?: string; pin?: string };
  try { body = await req.json(); } catch { return reply(400, { error: "Bad request." }); }
  const token = String(body.token ?? "").trim();
  const pin = String(body.pin ?? "").trim();
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) return reply(400, { error: "That link isn't right. Ask the office for your personal link." });
  if (!/^\d{4}$/.test(pin)) return reply(400, { error: "Enter your 4-digit PIN." });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  const { data: check, error } = await admin.rpc("staff_login_check", { p_link_hash: await sha256Hex(token), p_pin: pin });
  if (error) return reply(500, { error: error.message });

  switch (check?.status) {
    case "ok": break;
    case "bad_link": return reply(401, { error: "That link isn't active. Ask the office for your personal link." });
    case "inactive": return reply(403, { error: "Your access has been switched off. Speak to the office." });
    case "locked": return reply(429, { error: "Too many wrong PINs. Try again in 15 minutes, or ask the office to reset it." });
    case "bad_pin": return reply(401, { error: check.left > 0 ? `Wrong PIN. ${check.left} tries left.` : "Wrong PIN. Locked for 15 minutes." });
    default: return reply(500, { error: "Sign-in check failed." });
  }

  const { data: user, error: userError } = await admin.auth.admin.getUserById(check.user_id);
  if (userError || !user.user?.email) return reply(500, { error: userError?.message ?? "No login found for this person." });

  const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: "magiclink", email: user.user.email });
  if (linkError || !link.properties?.hashed_token) return reply(500, { error: linkError?.message ?? "Could not start the session." });

  return reply(200, { token_hash: link.properties.hashed_token, name: check.name });
});
