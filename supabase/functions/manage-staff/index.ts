// Supabase Edge Function: manage-staff
//
// The office adds people, resets a lost link or forgotten PIN, and switches
// people off. Each new person gets a personal link and a 4-digit PIN, shown to
// the office ONCE to pass on; only hashes are stored.
//
// Actions (POST JSON):
//   { action: "setup", code, name, company:"platform" }  the product owner's own login, once,
//                                               with the SETUP_CODE secret. Clients can no longer
//                                               be set up with the code (see client_owner).
//   { action: "client_owner", company_id, name } product owner only: a client's first owner
//   { action: "add", name, role }               office/manager (owner roles by an owner only)
//   { action: "reset", staff_id }               new link + PIN, the old link stops working
//   { action: "off" | "on", staff_id }          switch access off / back on (history is kept)
//   every action also sends app_url, the address the personal link should open
//
// "Verify JWT" must be OFF (setup runs before anyone exists); everything
// except setup checks the caller's own sign-in and role here.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const ROLES = ["owner", "office", "manager", "bongo", "terminal", "view"];

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randomPin() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 10000;
  return String(n).padStart(4, "0");
}
async function sha256Hex(text: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "POST only." });

  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return reply(400, { error: "Bad request." }); }
  const action = String(body.action ?? "");
  const appUrl = String(body.app_url ?? "");
  if (!/^https:\/\/[^\s/$.?#].[^\s]*$/.test(appUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(appUrl)) {
    return reply(400, { error: "Missing the app address." });
  }
  const linkFor = (token: string) => appUrl.replace(/[#?].*$/, "") + "#t=" + token;

  // Creates the hidden login, the staff row and their link + PIN.
  async function createPerson(companyId: string, name: string, role: string) {
    const staffId = crypto.randomUUID();
    const { data: created, error: userError } = await admin.auth.admin.createUser({
      email: `staff-${staffId}@example.com`,          // never emailed: sign-in is link + PIN
      // Supabase Auth passwords max out at 72 characters. One token is
      // already a 43-character random password and is sufficient here.
      password: randomToken(),
      email_confirm: true,
      user_metadata: { staff_id: staffId },
    });
    if (userError || !created.user) throw new Error(userError?.message ?? "Could not create the login.");
    const { error: rowError } = await admin.from("staff").insert({ id: staffId, company_id: companyId, user_id: created.user.id, name, role });
    if (rowError) { await admin.auth.admin.deleteUser(created.user.id); throw new Error(rowError.message); }
    const token = randomToken(), pin = randomPin();
    const { error: secretError } = await admin.rpc("set_staff_secret", { p_staff: staffId, p_link_hash: await sha256Hex(token), p_pin: pin });
    if (secretError) { await admin.from("staff").delete().eq("id", staffId); await admin.auth.admin.deleteUser(created.user.id); throw new Error(secretError.message); }
    return { staff_id: staffId, name, role, link: linkFor(token), pin };
  }

  try {
    // ── first owner ─────────────────────────────
    if (action === "setup") {
      const code = Deno.env.get("SETUP_CODE");
      if (!code || String(body.code ?? "") !== code) return reply(403, { error: "Wrong setup code." });
      // Only the product owner's own login is made with the code. A client's
      // first owner is made from the Clients page, by the product owner.
      if (String(body.company ?? "") !== "platform") return reply(403, { error: "This setup link no longer works. Ask Parking Ops for your personal link." });
      const { data: company } = await admin.from("companies").select("id").eq("slug", "platform").maybeSingle();
      if (!company) return reply(404, { error: "Company not found. Run database part 1 first." });
      const { count } = await admin.from("staff").select("id", { count: "exact", head: true })
        .eq("company_id", company.id).in("role", ["owner", "office", "manager"]).eq("active", true);
      if ((count ?? 0) > 0) return reply(409, { error: "Setup is already done. Ask the office to add you." });
      const name = String(body.name ?? "").trim().slice(0, 60);
      if (!name) return reply(400, { error: "Enter your name." });
      return reply(200, await createPerson(company.id, name, "owner"));
    }

    // ── everything else: who is asking? ────────
    const auth = req.headers.get("Authorization") ?? "";
    const asCaller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      auth: { persistSession: false }, global: { headers: { Authorization: auth } },
    });
    const { data: me, error: meError } = await asCaller.rpc("staff_admin_context");
    if (meError || !me) return reply(401, { error: "Sign in again." });

    // ── a client's first owner, made by the product owner ──
    if (action === "client_owner") {
      const { data: isAdmin } = await asCaller.rpc("is_platform_admin");
      if (isAdmin !== true) return reply(403, { error: "Not allowed." });
      const { data: client } = await admin.from("companies").select("id, slug, brand, suspended_at").eq("id", String(body.company_id ?? "")).maybeSingle();
      if (!client || client.slug === "platform") return reply(404, { error: "Client not found." });
      if (client.suspended_at) return reply(409, { error: "Resume this client first." });
      const { count } = await admin.from("staff").select("id", { count: "exact", head: true })
        .eq("company_id", client.id).in("role", ["owner", "office", "manager"]).eq("active", true);
      if ((count ?? 0) > 0) return reply(409, { error: "This client already has an owner or office. They add people from their own Staff screen." });
      const name = String(body.name ?? "").trim().slice(0, 60);
      if (!name) return reply(400, { error: "Enter the name of the client's boss." });
      // The link opens the client's own address, so the app wears their brand.
      const host = String((client.brand as Record<string, unknown> | null)?.host ?? "");
      const clientUrl = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? "https://" + host + "/" : appUrl;
      const made = await createPerson(client.id, name, "owner");
      return reply(200, { ...made, link: clientUrl.replace(/[#?].*$/, "") + made.link.slice(made.link.indexOf("#t=")) });
    }

    if (!me.can_staff) return reply(403, { error: "Only the office can manage staff." });

    if (action === "add") {
      const name = String(body.name ?? "").trim().slice(0, 60);
      const role = String(body.role ?? "");
      if (!name) return reply(400, { error: "Enter the person's name." });
      if (!ROLES.includes(role)) return reply(400, { error: "Choose a role." });
      if (role === "owner" && me.role !== "owner") return reply(403, { error: "Only an owner can add another owner." });
      // Office can add people but not managers: a manager's link and PIN would
      // give office Settings and staff-access powers (part 17).
      if (role === "manager" && !["owner", "manager"].includes(me.role)) return reply(403, { error: "Only a manager or the owner can add a manager." });
      return reply(200, await createPerson(me.company_id, name, role));
    }

    const staffId = String(body.staff_id ?? "");
    const { data: person } = await admin.from("staff").select("id, company_id, user_id, name, role, active").eq("id", staffId).maybeSingle();
    if (!person || person.company_id !== me.company_id) return reply(404, { error: "Person not found." });
    if (person.role === "owner" && me.role !== "owner") return reply(403, { error: "Only an owner can change an owner." });
    if (person.role === "manager" && !["owner", "manager"].includes(me.role)) return reply(403, { error: "Only a manager or the owner can change a manager." });

    if (action === "reset") {
      const token = randomToken(), pin = randomPin();
      const { error } = await admin.rpc("set_staff_secret", { p_staff: person.id, p_link_hash: await sha256Hex(token), p_pin: pin });
      if (error) throw new Error(error.message);
      return reply(200, { staff_id: person.id, name: person.name, role: person.role, link: linkFor(token), pin });
    }

    if (action === "off" || action === "on") {
      if (person.id === me.staff_id) return reply(400, { error: "You can't switch yourself off." });
      const on = action === "on";
      if (person.user_id) {
        const { error: banError } = await admin.auth.admin.updateUserById(person.user_id, { ban_duration: on ? "none" : "876000h" });
        if (banError) throw new Error(banError.message);
      }
      const { error } = await admin.from("staff").update({ active: on }).eq("id", person.id);
      if (error) throw new Error(error.message);
      return reply(200, { staff_id: person.id, active: on });
    }

    return reply(400, { error: "Unknown action." });
  } catch (err) {
    return reply(500, { error: (err as Error).message ?? String(err) });
  }
});
