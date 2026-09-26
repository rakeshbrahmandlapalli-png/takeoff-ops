// Parking Ops — the app. One codebase, several parking companies.
//
// Data lives in TAKEOFF's own Supabase project. The page only ever READS
// tables; every change goes through a database function that checks the
// person's role and writes the activity log (setup/01-core.sql).
//
// Taps are applied on screen straight away and saved through a queue kept on
// the phone, so a weak signal on the yard never loses a tap: it saves when
// the signal comes back. Changes by anyone else arrive live (Supabase Realtime).
(function () {
  "use strict";

  var CFG = {
    url: "https://oioqjfrlwrjovnouhusp.supabase.co",
    // TAKEOFF's public (anon) key: safe in the page, it can only do what the
    // database rules allow a signed-in person to do.
    key: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9pb3FqZnJsd3Jqb3Zub3VodXNwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk2Mjk3MDQsImV4cCI6MjEwNTIwNTcwNH0.09ddpfS4_KwZN7QWJoAiwaIl02wQLaw6yJWEltNMQ2U"
  };
  var TZ = "Europe/London";
  var LINK_KEY = "takeoff_link";

  // ── helpers ───────────────────────────────
  var $ = function (id) { return document.getElementById(id); };
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function pad(n) { return String(n).padStart(2, "0"); }
  function toast(msg, bad) {
    var t = document.createElement("div"); t.className = "toast" + (bad ? " bad" : ""); t.setAttribute("role", "status"); t.textContent = msg;
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, bad ? 5000 : 3000);
  }
  // One formatter per format, made once: building one per call made a big
  // board (hundreds of cars, several times each) slow to redraw after a tap.
  var FMT = {};
  function fmt(k, o) { return FMT[k] || (FMT[k] = new Intl.DateTimeFormat("en-GB", o)); }
  function hhmm(ts) { return ts ? fmt("hm", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(new Date(ts)) : ""; }
  function dayShort(ts) { return ts ? fmt("day", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" }).format(new Date(ts)) : ""; }
  function londonParts(d) {
    var p = {}; fmt("parts", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
      .formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
    return { key: p.year + "-" + p.month + "-" + p.day, time: (p.hour === "24" ? "00" : p.hour) + ":" + p.minute };
  }
  function addDaysKey(key, n) { var d = new Date(key + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  // "DROPS 17TH SEPT", the way the Sheet's tabs were named.
  function sheetLabel(s) {
    if (!s.day) return s.kind.toUpperCase();
    var d = new Date(s.day + "T12:00:00Z"), n = d.getUTCDate();
    var th = n >= 11 && n <= 13 ? "TH" : ({ 1: "ST", 2: "ND", 3: "RD" }[n % 10] || "TH");
    return s.kind.toUpperCase() + " " + n + th + " " + fmt("mon", { month: "short", timeZone: "UTC" }).format(d).toUpperCase().replace(/\.$/, "");
  }
  function show(id, on) { $(id).classList.toggle("hidden", !on); }
  function only(id) { ["boot", "noLink", "pinGate", "setupGate", "app"].forEach(function (x) { show(x, x === id); }); }

  // Requests give up after 20 seconds, so a dead signal ends in a clear state.
  function timedFetch(input, init) {
    var ctrl = new AbortController(), outer = init && init.signal;
    if (outer) { if (outer.aborted) ctrl.abort(); else outer.addEventListener("abort", function () { ctrl.abort(); }); }
    var timer = setTimeout(function () { ctrl.abort(); }, 20000);
    return fetch(input, Object.assign({}, init, { signal: ctrl.signal })).finally(function () { clearTimeout(timer); });
  }
  function isNetwork(err) { return !navigator.onLine || /Failed to fetch|NetworkError|Load failed|AbortError|aborted|network/i.test(String((err && (err.message || err.name)) || err)); }
  // The server itself in trouble (outage, overload, timeout), as opposed to a
  // real "no": worth waiting and trying again, never a reason to drop a tap
  // or sign anyone out.
  function isDown(res) {
    var err = res && res.error !== undefined ? res.error : res, st = res && res.status !== undefined ? +res.status : 0;
    if (!err) return false;
    if (isNetwork(err)) return true;
    st = st || +err.status || +err.statusCode || 0;
    return st >= 500 || st === 429 || st === 408 || /upstream|timed? ?out|unavailable|bad gateway|gateway|temporarily|overloaded|too many|ECONN|fetch failed/i.test(String(err.message || err.hint || ""));
  }
  function isAuth(err) { return !!err && (err.status === 401 || err.code === "PGRST301" || /JWT expired|invalid jwt|refresh token|Auth session missing/i.test(String(err.message || ""))); }

  // The app can't do anything without its database library: say so and offer
  // a reload rather than a blank page.
  if (!window.supabase) {
    only("boot");
    $("boot").innerHTML = "The app didn't load properly. Check your signal.<br><br>";
    var reload0 = document.createElement("button"); reload0.className = "btn"; reload0.textContent = "Try again";
    reload0.onclick = function () { location.reload(); }; $("boot").appendChild(reload0);
    return;
  }
  var sb = window.supabase.createClient(CFG.url, CFG.key, { global: { fetch: timedFetch } });

  async function callFunction(name, body, withSession) {
    var headers = { "Content-Type": "application/json", apikey: CFG.key, Authorization: "Bearer " + CFG.key };
    if (withSession) {
      var s = (await sb.auth.getSession()).data.session;
      if (!s) throw new Error("Sign in again.");
      headers.Authorization = "Bearer " + s.access_token;
    }
    var res;
    try { res = await timedFetch(CFG.url + "/functions/v1/" + name, { method: "POST", headers: headers, body: JSON.stringify(body) }); }
    catch (e) { throw new Error("Can't reach the server. Check your signal and try again."); }
    var data = {}; try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error(data.error || data.message || ("Error " + res.status));
    return data;
  }

  // ── state ─────────────────────────────────
  var S = {
    me: null, perms: {}, company: null, staff: {}, sheets: [], sheetId: null, rows: [],
    view: "board", filter: "todo", q: "", yardFilter: "", catFilter: "", runs: null, pending: {}, queue: [], flushing: false, live: false,
    imp: null, issued: null, activity: null
  };
  function can(a) { return !!S.perms[a]; }
  function sheet() { return S.sheets.concat(S.archiveSheet ? [S.archiveSheet] : []).filter(function (s) { return s.id === S.sheetId; })[0] || null; }
  function staffName(id) { return id && S.staff[id] ? S.staff[id].name : ""; }

  // ── sign-in ───────────────────────────────
  var linkFromHash = (location.hash.match(/^#t=([A-Za-z0-9_-]{32,64})$/) || [])[1];
  if (linkFromHash) {
    try { localStorage.setItem(LINK_KEY, linkFromHash); } catch (e) {}
    history.replaceState(null, "", location.pathname);
  }

  async function start() {
    brandFromServer(location.hostname);
    var setupHash = location.hash.match(/^#setup(?:=([a-z0-9-]{1,60}))?$/);
    if (setupHash) {
      S.setupCompany = setupHash[1] || "";
      brandFromServer(S.setupCompany || location.hostname);
      only("setupGate"); $("setupName").focus(); return;
    }
    var session = (await sb.auth.getSession()).data.session;
    // A new personal link on a phone signed in as someone else: that person signs out.
    if (session && linkFromHash) { await sb.auth.signOut(); session = null; }
    if (session) return loadApp();
    showSignIn();
  }
  function storedLink() { try { return localStorage.getItem(LINK_KEY) || ""; } catch (e) { return ""; } }
  function showSignIn(message) {
    if (storedLink()) { only("pinGate"); $("pinErr").textContent = message || ""; $("pin").value = ""; $("pin").focus(); }
    else only("noLink");
  }

  $("pinForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var pin = $("pin").value.trim();
    if (!/^\d{4}$/.test(pin)) { $("pinErr").textContent = "Enter your 4-digit PIN."; return; }
    $("pinGo").disabled = true; $("pinErr").textContent = "";
    try {
      var r = await callFunction("staff-login", { token: storedLink(), pin: pin }, false);
      var v = await sb.auth.verifyOtp({ type: "magiclink", token_hash: r.token_hash });
      if (v.error) throw v.error;
      await loadApp();
    } catch (err) { $("pinErr").textContent = err.message || String(err); $("pin").value = ""; }
    finally { $("pinGo").disabled = false; }
  });
  $("pin").addEventListener("input", function () { if (/^\d{4}$/.test(this.value)) $("pinForm").requestSubmit(); });
  // The Home Screen app on an iPhone keeps its own storage, so a link opened in
  // Safari never reaches it. Accepts the whole link, a message containing it, or
  // just the code after "#t=".
  function linkFromPaste(text) {
    var s = String(text || "").trim();
    var m = s.match(/[#&?]t=([A-Za-z0-9_-]{32,64})/) || s.match(/^([A-Za-z0-9_-]{32,64})$/);
    return m ? m[1] : "";
  }
  $("linkForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var token = linkFromPaste($("linkPaste").value);
    if (!token) { $("linkErr").textContent = "That isn't a " + brandName() + " link. Copy the whole link the office sent you."; return; }
    try { localStorage.setItem(LINK_KEY, token); } catch (err) { $("linkErr").textContent = "This phone won't let " + brandName() + " save your link. Turn off private browsing and try again."; return; }
    $("linkErr").textContent = ""; $("linkPaste").value = "";
    showSignIn();
  });
  $("forget").addEventListener("click", function () {
    if (!confirm("Remove your " + brandName() + " link from this phone? You'll need the office to send it again.")) return;
    try { localStorage.removeItem(LINK_KEY); localStorage.removeItem(BRAND_KEY); } catch (e) {}
    only("noLink");
  });

  $("setupForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var name = $("setupName").value.trim(), code = $("setupCode").value;
    if (!name || !code) { $("setupErr").textContent = "Enter your name and the setup code."; return; }
    $("setupGo").disabled = true; $("setupErr").textContent = "";
    try {
      // "#setup" sets up the default company; "#setup=<slug>" sets up that
      // company. One app, so the first owner of each has to say which.
      var slug = (S.setupCompany || "").trim();
      var r = await callFunction("manage-staff", { action: "setup", code: code, name: name,
        company: slug || "takeoff", app_url: location.origin + "/" }, false);
      $("setupDone").innerHTML = issuedHtml(r) + '<a class="btn brand" href="' + esc(r.link) + '">Sign in on this device</a>';
      show("setupDone", true); $("setupGo").classList.add("hidden");
    } catch (err) { $("setupErr").textContent = err.message; }
    finally { $("setupGo").disabled = false; }
  });

  sb.auth.onAuthStateChange(function (event) {
    if (event === "SIGNED_OUT" && S.me) { S.me = null; teardown(); showSignIn("You've been signed out. Enter your PIN to sign in again."); }
  });

  // ── loading ───────────────────────────────
  var channel = null;
  async function loadApp() {
    try { await loadAppInner(); } catch (err) { oopsLog(err); bootTrouble(); }
  }
  // Loading went wrong somewhere: never a blank page, always a way back in.
  function bootTrouble() {
    if (S.me && !$("app").classList.contains("hidden")) return;
    only("boot");
    $("boot").innerHTML = "Something went wrong while loading. Check your signal and try again.<br><br>";
    var again = document.createElement("button"); again.className = "btn"; again.textContent = "Try again";
    again.onclick = function () { location.reload(); }; $("boot").appendChild(again);
  }
  async function loadAppInner(quiet) {
    if (!quiet) { only("boot"); $("boot").textContent = "Loading…"; }
    var me = await sb.rpc("me");
    if (me.error) {
      // Only a real sign-in problem signs out. Anything else (no signal, the
      // server down) opens the last board this phone had, if there is one.
      if (isAuth(me.error)) { toast(me.error.message, true); await sb.auth.signOut(); return showSignIn(); }
      if (openFromSnap()) return;
      $("boot").innerHTML = (isDown(me) ? "Can't reach the server just now. Check your signal, or it may be down for a few minutes." : "Couldn't load: " + esc(me.error.message)) + "<br><br>";
      var again = document.createElement("button"); again.className = "btn"; again.textContent = "Try again"; again.onclick = loadApp; $("boot").appendChild(again); return;
    }
    if (!me.data || !me.data.id) { await sb.auth.signOut(); return showSignIn("Your access is switched off. Speak to the office."); }
    S.me = me.data;
    var res = await Promise.all([
      sb.rpc("my_permissions"),
      sb.from("companies").select("*").eq("id", S.me.company_id).single(),
      sb.from("staff").select("id, name, role, active, created_at, extra, removed_at").order("name"),
      loadSheets()
    ]);
    if (!res[1].data || res.some(function (x) { return x && x.error && isDown(x); })) { if (openFromSnap()) return; throw new Error("Couldn't load the company"); }
    S.offline = false;
    S.perms = res[0].data || {};
    S.company = res[1].data;
    applyBrand(S.company);
    S.staff = {}; (res[2].data || []).forEach(function (p) { S.staff[p.id] = p; });
    // The product owner's own login: no board, just the Clients page.
    S.platform = !!(S.company && S.company.slug === "platform");
    if (S.platform) { S.view = "clients"; only("app"); render(); return; }
    loadQueue();
    pickDefaultSheet();
    await loadRows();
    subscribe();
    only("app");
    render();
    flush();
    ptResume();
    loadLastDownload();
  }
  var PICKER_DAYS = 90;
  async function loadSheets() {
    // The picker holds 90 days back and anything imported ahead. Older days
    // are on the Archive screen and are never deleted.
    var r = await sb.from("sheets").select("*").gte("day", addDaysKey(londonParts(new Date()).key, -PICKER_DAYS))
      .order("day", { ascending: false }).order("kind").limit(400);
    if (!r.error) {
      S.sheets = (r.data || []).filter(function (x) { return !x.archived_at; });
      S.handArchived = (r.data || []).filter(function (x) { return x.archived_at; });
    }
    return r;
  }
  // The DROPS sheet for the shift running now (it runs to 06:00 next morning).
  function currentShiftKey() {
    var now = londonParts(new Date()), end = (S.company && S.company.drops_day_end || "06:00:00").slice(0, 5);
    return now.time <= end ? addDaysKey(now.key, -1) : now.key;
  }
  // A refresh keeps the sheet that was open; a fresh start of the app opens
  // the current DROPS again.
  function openSheetKey() { return "open_sheet_" + (S.company ? S.company.id : ""); }
  function pickDefaultSheet() {
    if (S.sheetId && sheet()) return;
    var kept = null; try { kept = sessionStorage.getItem(openSheetKey()); } catch (e) {}
    if (kept && S.sheets.some(function (s) { return s.id === kept; })) { S.sheetId = kept; return; }
    var key = currentShiftKey();
    var hit = S.sheets.filter(function (s) { return s.kind === "drops" && s.day === key; })[0] ||
              S.sheets.filter(function (s) { return s.kind === "drops" && s.day <= key; })[0] || S.sheets[0];
    S.sheetId = hit ? hit.id : null;
  }
  // Loads can overlap (waking, signal back, refresh, live updates, a sheet
  // switch). Only the newest one for the sheet on screen may fill the board,
  // so a late answer can never put one sheet's cars under another's name.
  var loadSeq = 0;
  async function loadRows() {
    if (!S.sheetId) { S.rows = []; return; }
    var sh = sheet(), want = S.sheetId, seq = ++loadSeq;
    try { if (sh && !sh.archived_at) sessionStorage.setItem(openSheetKey(), want); } catch (e) {}
    var r = await sb.from("bookings").select("*").eq("sheet_id", want).order(sh && sh.kind === "picks" ? "drop_at" : "return_at", { ascending: true, nullsFirst: false });
    if (seq !== loadSeq || want !== S.sheetId) return;
    if (r.error) {
      // Keep showing the sheet that's loaded, not another sheet's name over it.
      if (S.rowsSheet && S.rowsSheet !== S.sheetId) S.sheetId = S.rowsSheet;
      toast(isDown(r) ? "The server isn't answering. Still showing what was loaded." : r.error.message, true); return;
    }
    // A different sheet: the filters picked on the last one don't apply here.
    if (S.rowsSheet !== want) { S.catFilter = ""; S.yardFilter = ""; }
    S.rowsSheet = want;
    S.rows = (r.data || []).filter(function (x) { return !x.removed_at; });
    S.removed = (r.data || []).filter(function (x) { return x.removed_at; });
  }
  function dropRemoved(id) { S.removed = (S.removed || []).filter(function (x) { return x.id !== id; }); }
  // A yard picker open on a row must not be redrawn out from under the finger.
  function yardOpen() { var a = document.activeElement; return !!(a && a.dataset && a.dataset.yard !== undefined); }

  function subscribe() {
    if (channel) sb.removeChannel(channel);
    var ch = channel = sb.channel("bookings-" + S.company.id);
    ch.on("postgres_changes", { event: "*", schema: "public", table: "bookings", filter: "company_id=eq." + S.company.id }, onChange)
      // A new import on any phone shows up in everyone's sheet list.
      .on("postgres_changes", { event: "*", schema: "public", table: "sheets", filter: "company_id=eq." + S.company.id }, function () {
        loadSheets().then(function () { var had = S.sheetId; pickDefaultSheet(); return had === S.sheetId ? null : loadRows(); }).then(function () { if (!$("panel").open && !yardOpen()) render(); });
      })
      .subscribe(function (status) {
        if (ch !== channel) return;   // an old link closing late (after sign-out and back in)
        var was = S.live; S.live = status === "SUBSCRIBED"; renderSync();
        // Back after the live link dropped: changes made meanwhile were missed, so fetch once.
        if (S.live && liveLost) { liveLost = false; loadRows().then(function () { if (!$("panel").open && !yardOpen()) render(); }); }
        if (was && !S.live) liveLost = true;
      });
  }
  var liveLost = false;
  function teardown() { if (channel) sb.removeChannel(channel); channel = null; liveLost = false; S.rows = []; snapForget(); }

  // ── the last board, kept on the phone ──
  // If the server can't be reached when the app opens, the team still sees the
  // last board this phone loaded and can keep tapping: the taps are saved on
  // the phone and go through when the server answers again. Cleared on sign-out.
  var SNAP_KEY = "takeoff_snap", snapTimer = null;
  function snapSave() {
    if (!S.me || !S.company || S.platform) return;
    clearTimeout(snapTimer);
    snapTimer = setTimeout(function () {
      try {
        localStorage.setItem(SNAP_KEY, JSON.stringify({ v: 1, at: S.offline ? S.offlineAt : new Date().toISOString(), me: S.me, perms: S.perms, company: S.company,
          staff: S.staff, sheets: S.sheets, handArchived: S.handArchived, sheetId: S.rowsSheet || S.sheetId, rows: S.rows, removed: S.removed }));
      } catch (e) {}
    }, 2000);
  }
  function snapForget() { clearTimeout(snapTimer); try { localStorage.removeItem(SNAP_KEY); } catch (e) {} }
  function openFromSnap() {
    var x = null; try { x = JSON.parse(localStorage.getItem(SNAP_KEY) || "null"); } catch (e) {}
    if (!x || !x.me || !x.company || !x.rows) return false;
    S.me = x.me; S.perms = x.perms || {}; S.company = x.company; S.staff = x.staff || {};
    S.sheets = x.sheets || []; S.handArchived = x.handArchived || []; S.sheetId = x.sheetId; S.rowsSheet = x.sheetId;
    S.rows = x.rows; S.removed = x.removed || [];
    S.offline = true; S.offlineAt = x.at; S.live = false;
    try { applyBrand(S.company); } catch (e) {}
    loadQueue(); only("app"); render();
    toast("The server can't be reached. Showing the board from " + hhmm(x.at) + "; taps are saved and go through when it's back.", true);
    clearTimeout(S.reconnect); S.reconnect = setTimeout(reconnect, 15000);
    return true;
  }
  // Offline: try the server every 15 s (then less often); when it answers,
  // load everything fresh and send the saved taps.
  async function reconnect() {
    if (!S.offline) return;
    var me; try { me = await sb.rpc("me"); } catch (e) { me = { error: e }; }
    if (me && !me.error && me.data && me.data.id) {
      try { await loadAppInner(true); if (!S.offline) toast("Back online. Board up to date."); }
      catch (e) { oopsLog(e); if (S.me) { S.offline = true; renderSync(); clearTimeout(S.reconnect); S.reconnect = setTimeout(reconnect, 20000); } }
      return;
    }
    if (me && me.error && isAuth(me.error)) { S.offline = false; S.me = null; teardown(); await sb.auth.signOut(); return showSignIn(); }
    S.reconnectWait = Math.min(120000, (S.reconnectWait || 10000) * 1.5);
    S.reconnect = setTimeout(reconnect, S.reconnectWait);
  }

  var redraw = null;
  function onChange(p) {
    var n = p.new || {}, o = p.old || {}, id = n.id || o.id;
    var idx = S.rows.findIndex(function (r) { return r.id === id; });
    if (p.eventType === "DELETE") { if (idx >= 0) S.rows.splice(idx, 1); dropRemoved(id); }
    else if (n.sheet_id === S.sheetId && n.removed_at) { if (idx >= 0) S.rows.splice(idx, 1); dropRemoved(id); S.removed.push(n); }
    else if (n.sheet_id === S.sheetId) {
      dropRemoved(id);
      if (S.pending[id]) return;                   // our own tap is still saving; its answer wins
      var before = idx >= 0 ? S.rows[idx] : null;
      if (idx >= 0) S.rows[idx] = n; else S.rows.push(n);
      // Flash a row someone else tapped, not every flight-time refresh.
      if (!before || TAP_FIELDS.some(function (k) { return before[k] !== n[k]; })) flashId = id;
    } else if (idx >= 0) S.rows.splice(idx, 1);
    clearTimeout(redraw); redraw = setTimeout(function () { if ((S.view === "board" || S.view === "flights") && !$("panel").open && !yardOpen()) render(); }, 150);
  }
  var flashId = null;
  var TAP_FIELDS = ["yard", "sent_at", "called_at", "called_word", "cleared_at", "clear_word", "intake", "pt_at", "pick_called", "note", "charge_method"];

  // ── saving: optimistic, queued, retried ───
  function queueKey() { return "takeoff_queue_" + (S.me ? S.me.id : ""); }
  function loadQueue() { try { S.queue = JSON.parse(localStorage.getItem(queueKey()) || "[]"); } catch (e) { S.queue = []; } S.pending = {}; S.queue.forEach(function (op) { S.pending[op.rowId] = (S.pending[op.rowId] || 0) + 1; }); }
  function saveQueue() { try { localStorage.setItem(queueKey(), JSON.stringify(S.queue)); } catch (e) {} }

  function run(fn, args, row, mutate) {
    if (row && mutate) mutate(row);
    S.queue.push({ fn: fn, args: args, rowId: row ? row.id : null });
    if (row) S.pending[row.id] = (S.pending[row.id] || 0) + 1;
    saveQueue(); render(); flush();
  }
  var retryTimer = null;
  async function flush() {
    if (S.flushing || !S.queue.length || !S.me) { renderSync(); return; }
    S.flushing = true; renderSync();
    var op = S.queue[0];
    var r = await sb.rpc(op.fn, op.args);
    S.flushing = false;
    if (r.error && isDown(r)) {
      // Kept and tried again: every 5 s, slowing to once a minute in a long outage.
      S.retryWait = Math.min(60000, (S.retryWait || 2500) * 2);
      renderSync(); clearTimeout(retryTimer); retryTimer = setTimeout(flush, S.retryWait); return;
    }
    S.retryWait = 0;
    // Sign-in expired: renew it and try again. If it can't be renewed the app
    // is signed out and asks for the PIN, and the saved taps go after that.
    if (r.error && isAuth(r.error)) {
      renderSync();
      try { var ref = await sb.auth.refreshSession(); if (!ref.error) { clearTimeout(retryTimer); retryTimer = setTimeout(flush, 1000); } } catch (e) {}
      return;
    }
    S.queue.shift(); saveQueue();
    if (op.rowId) { S.pending[op.rowId] = Math.max(0, (S.pending[op.rowId] || 1) - 1); if (!S.pending[op.rowId]) delete S.pending[op.rowId]; }
    if (r.error) {
      toast(r.error.message, true);
      if (op.rowId) await refreshRow(op.rowId);     // put back what the database really holds
    } else if (r.data && r.data.id && !S.pending[r.data.id]) {
      var idx = S.rows.findIndex(function (x) { return x.id === r.data.id; });
      if (idx >= 0) S.rows[idx] = r.data;
    }
    if (!$("panel").open && !yardOpen()) render();
    flush();
  }
  async function refreshRow(id) {
    var r = await sb.from("bookings").select("*").eq("id", id).maybeSingle();
    var idx = S.rows.findIndex(function (x) { return x.id === id; });
    if (r.data && idx >= 0) S.rows[idx] = r.data;
  }
  window.addEventListener("online", function () { flush(); if (S.me) loadRows().then(render); });
  // Coming back to the app: a quick trip away (WhatsApp for PT, a call) with
  // the live link still up needs no fetch, the board is already current. A
  // longer one, or a dropped link, reloads. (Reloading on every return was
  // ~3,000 full-sheet downloads a night: most of the free plan's traffic.)
  var hiddenAt = 0, QUICK_BACK = 90000;
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
    if (!S.me) return;
    flush();
    if (S.live && hiddenAt && Date.now() - hiddenAt < QUICK_BACK) {
      // Belt and braces: just the cars changed while away (usually none), in
      // case a live update went astray while the phone was asleep.
      if (Date.now() - hiddenAt > 15000) catchUp(hiddenAt - 10000);
      else if (!$("panel").open) render();
      return;
    }
    loadSheets().then(loadRows).then(function () { if (!$("panel").open) render(); });
  });

  async function catchUp(sinceMs) {
    var want = S.sheetId; if (!want) return;
    var r = await sb.from("bookings").select("*").eq("sheet_id", want).gte("updated_at", new Date(sinceMs).toISOString());
    if (r.error || want !== S.sheetId) return;
    (r.data || []).forEach(function (n) { onChange({ eventType: "UPDATE", new: n, old: {} }); });
    if (!(r.data || []).length && !$("panel").open) render();
  }
  function renderSync() {
    var el = $("sync"); if (!el) return;
    var waiting = S.queue.length;
    // Silent while all is well, like the Sheet app: it only speaks up when a
    // tap is waiting or live updates have dropped.
    var down = S.offline || !!S.retryWait;
    el.className = "pend" + (waiting || !S.live || down ? " on" : "") + (!navigator.onLine || down ? " stuck" : "");
    el.textContent = S.offline ? "OFFLINE · BOARD FROM " + hhmm(S.offlineAt) + (waiting ? " · " + waiting + " TO SEND" : "")
      : waiting ? (!navigator.onLine ? "OFFLINE · " + waiting : S.retryWait ? "SERVER BUSY · " + waiting + " WAITING" : "SAVING " + waiting)
      : (S.live ? "" : navigator.onLine ? "CONNECTING" : "OFFLINE");
  }

  // ── chrome ────────────────────────────────
  // The header is the one the team already knows from the Sheet app: sheet
  // picker, who is signed in, and a row of icon buttons. The yard tally, TO DO /
  // ALL, search and column captions belong to the board only.
  var VIEW_TITLE = { clients: "Clients", flights: "Flights", summary: "Summary and activity", import: "Import bookings", staff: "Staff", settings: "Settings", archive: "Archive", me: "Me" };
  var YARD_LABEL = { Y: "NB", S: "S YARD" };
  // The tally reads left to right as the Sheet's did; any yard not listed follows.
  var YARD_ORDER = ["Y", "S", "CP", "NY", "T"];
  function yardOrder() {
    var ys = S.company.yards || [];
    return YARD_ORDER.filter(function (y) { return ys.indexOf(y) !== -1; }).concat(ys.filter(function (y) { return YARD_ORDER.indexOf(y) === -1; }));
  }

  function renderChrome() {
    var sh = sheet(), picks = !!(sh && sh.kind === "picks"), board = S.view === "board";
    document.body.classList.toggle("picks", picks);
    document.body.classList.toggle("on-board", board);
    $("who").textContent = S.me.name.toUpperCase();
    $("clock").textContent = londonParts(new Date()).time;
    var shift = currentShiftKey();
    $("sheetPick").innerHTML = S.sheets.length || S.archiveSheet ? pickerHtml(shift) : "<option>No sheets yet</option>";
    show("sheetPick", !S.platform);
    show("logBtn", !S.platform && (can("summary") || can("log")));
    show("flBtn", !S.platform && can("flights") && !picks);
    show("rtBtn", !S.platform && can("picksinfo") && picks);
    show("psBtn", !S.platform && can("picksinfo"));
    show("boardHead", board);
    show("viewHead", !board);
    if (!board) $("viewTitle").textContent = VIEW_TITLE[S.view] || "";
    if (board) renderBoardHead();
    renderSync();
  }

  // Today and anything ahead first, then a group per month, so 90 days of
  // DROPS and PICKS stay quick to scroll on a phone.
  function pickerHtml(shift) {
    function opt(s) { return '<option value="' + s.id + '"' + (s.id === S.sheetId ? " selected" : "") + ">" + esc(sheetLabel(s)) + (s.day === shift ? " · today" : "") + "</option>"; }
    var ahead = S.sheets.filter(function (s) { return s.day >= shift; }).sort(function (a, b) { return a.day < b.day ? -1 : a.day > b.day ? 1 : a.kind < b.kind ? -1 : 1; });
    var h = ahead.length ? '<optgroup label="TODAY AND COMING UP">' + ahead.map(opt).join("") + "</optgroup>" : "";
    var months = {};
    S.sheets.filter(function (s) { return s.day < shift; }).forEach(function (s) { (months[s.day.slice(0, 7)] = months[s.day.slice(0, 7)] || []).push(s); });
    Object.keys(months).sort().reverse().forEach(function (m) {
      h += '<optgroup label="' + new Date(m + "-15T12:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).toUpperCase() + '">' + months[m].map(opt).join("") + "</optgroup>";
    });
    if (S.archiveSheet) h += '<optgroup label="OPENED FROM ARCHIVE">' + opt(S.archiveSheet) + "</optgroup>";
    return h;
  }

  function render() {
    if (!S.me) return;
    try { renderChrome(); } catch (err) { oopsLog(err); }
    var fn = { clients: renderClients, board: renderBoard, flights: renderFlights, summary: renderSummary, import: renderImport, staff: renderStaff, settings: renderSettings, archive: renderArchive, me: renderMe }[S.view] || renderBoard;
    var html;
    // One screen going wrong never takes the app down: it says so and offers a way out.
    try { html = fn(); } catch (err) {
      oopsLog(err);
      html = '<div class="msg">This screen couldn\'t be shown just now.<br><br>' + (S.view !== "board" ? '<button type="button" class="btn brand" data-view="board">Back to the board</button> ' : "") +
        '<button type="button" class="btn ghost" data-reload>Reload the app</button></div>';
    }
    $("main").innerHTML = html;
    snapSave();
    if (flashId) { var el = document.querySelector('[data-id="' + flashId + '"]'); if (el) { el.classList.add("flash"); setTimeout(function () { el.classList.remove("flash"); }, 1500); } flashId = null; }
  }
  function go(view) { if (S.platform && view !== "me") view = "clients"; S.view = view; S.settingsDraft = null; if (view === "summary") S.activity = null; if ($("menu").open) $("menu").close(); render(); window.scrollTo(0, 0); }

  // ── board ─────────────────────────────────
  // Same rules as the Sheet app, so nobody has to relearn what a count means.
  var WARN_MINS = 25, LATE_MINS = 50;
  function isPicks() { var sh = sheet(); return !!(sh && sh.kind === "picks"); }
  function minsSince(ts) { return ts ? (Date.now() - new Date(ts).getTime()) / 60000 : null; }

  // Still needs doing. DROPS: SENT and CLEAR both. PICKS: taken in AND
  // photographed; No Show and RTC need no photos.
  function outstanding(r) {
    if (r.kind === "drops") return !(r.sent_at && r.cleared_at);
    if (!r.intake) return true;
    return r.intake === "Collected" && !r.pt_at;
  }
  // Earlier days' cars nobody has rung about, or ones marked OVERSTAY.
  function inOverstayBlock(r) { return r.called_word === "Overstay" || (r.overstay && !r.called_at); }
  // The TO DO number: work nobody has picked up yet. A car already SENT is in hand.
  function waiting(r) { return outstanding(r) && (r.kind === "picks" || (!r.sent_at && !inOverstayBlock(r))); }

  // Running order: when the car is really needed. A flight two hours late is
  // needed two hours later, so a live or expected time beats the timetable.
  function orderAt(r) {
    if (r.kind === "picks") return r.drop_at || "9";
    // An early return is needed from when they rang, not their booked day.
    if (r.early) return r.est_at || r.called_at || r.early_at || "9";
    return r.est_at || r.sched_at || r.return_at || r.called_at || "9";
  }
  function yardOf(r) { return r.yard || ""; }

  // ── PICKS categories: where to park the car ──
  // A return up to the day-end (06:00) belongs to the day before, so a 22nd
  // 06:00 return is a 21st return. SHORT runs to the sheet's short date and
  // always includes SAME DAY and NEXT DAY.
  var CATS = [["same", "SAME DAY"], ["next", "NEXT DAY"], ["short", "SHORT"], ["long", "LONG"]];
  function returnDay(r) {
    if (!r.return_at) return "";
    var l = londonParts(new Date(r.return_at)), end = ((S.company && S.company.drops_day_end) || "06:00").slice(0, 5);
    return l.time <= end ? addDaysKey(l.key, -1) : l.key;
  }
  function catOf(r, sh) {
    sh = sh || sheet();
    var d = returnDay(r);
    if (!sh || sh.kind !== "picks" || !d) return "";
    if (d <= sh.day) return "same";
    if (d === addDaysKey(sh.day, 1)) return "next";
    if (!sh.short_until) return "";
    return d <= sh.short_until ? "short" : "long";
  }
  // SHORT LEFT / LONG LEFT on the board: the cars of that group still LEFT (not collected, no show or RTC).
  var LEFT_CATS = [["shortleft", "SHORT LEFT", "short"], ["longleft", "LONG LEFT", "long"]];
  function inCat(r, cat) {
    if (cat === "shortleft" || cat === "longleft") return (r.intake || "LEFT") === "LEFT" && inCat(r, cat === "shortleft" ? "short" : "long");
    var c = catOf(r); return cat === "short" ? c === "same" || c === "next" || c === "short" : c === cat;
  }
  function catCounts() {
    var n = { same: 0, next: 0, short: 0, long: 0, shortleft: 0, longleft: 0 };
    S.rows.forEach(function (r) { CATS.concat(LEFT_CATS).forEach(function (c) { if (inCat(r, c[0])) n[c[0]]++; }); });
    return n;
  }
  function dayWord(key) { var d = +key.slice(8, 10); return pad(d) + ordinal(d); }

  function visibleRows() {
    var q = S.q.trim().toUpperCase().replace(/^#/, "").replace(/\s+/g, "");
    return S.rows.filter(function (r) {
      // A search looks at the whole sheet: a car already done must still be findable from TO DO.
      if (q) return [r.reg, r.num, r.flight, r.name, r.phone, r.note, r.ref, r.make].join("").toUpperCase().replace(/\s+/g, "").indexOf(q) !== -1;
      if (S.filter === "todo" && !outstanding(r)) return false;
      if (S.catFilter && !inCat(r, S.catFilter)) return false;
      if (S.yardFilter) {
        if (r.kind === "picks" ? (r.intake || "LEFT") !== S.yardFilter : (S.yardFilter === "-" ? r.yard || r.cleared_at : r.yard !== S.yardFilter || r.cleared_at)) return false;
      }
      return true;
    }).sort(function (a, b) {
      var x = orderAt(a), y = orderAt(b);
      return x < y ? -1 : x > y ? 1 : (a.num || 0) - (b.num || 0);
    });
  }

  function renderBoardHead() {
    var picks = isPicks(), cells;
    if (picks) {
      var c = { LEFT: 0, Collected: 0, "No Show": 0, RTC: 0 };
      S.rows.forEach(function (r) { var k = r.intake || "LEFT"; if (c[k] !== undefined) c[k]++; });
      cells = [["LEFT", "LEFT", c.LEFT], ["COLL", "Collected", c.Collected], ["NO SHOW", "No Show", c["No Show"]], ["RTC", "RTC", c.RTC]];
    } else {
      var open = S.rows.filter(function (r) { return !r.cleared_at; });
      cells = yardOrder().map(function (y) { return [YARD_LABEL[y] || y, y, open.filter(function (r) { return r.yard === y; }).length]; });
      var none = open.filter(function (r) { return !r.yard; }).length;
      if (none && can("yard")) cells.push(["NO YARD", "-", none]);
    }
    $("tally").innerHTML = cells.map(function (x) {
      return '<button type="button" data-tally="' + esc(x[1]) + '" class="' + (S.yardFilter === x[1] ? "on" : "") + (x[1] === "-" ? " warn" : "") + '" aria-pressed="' + (S.yardFilter === x[1]) + '"><span>' + esc(x[0]) + '</span><b class="num">' + x[2] + "</b></button>";
    }).join("");
    renderCatStrip(picks);
    $("tabTodo").textContent = "TO DO (" + S.rows.filter(waiting).length + ")";
    $("tabAll").textContent = "ALL (" + S.rows.length + ")";
    $("tabTodo").classList.toggle("on", S.filter === "todo");
    $("tabAll").classList.toggle("on", S.filter === "all");
    $("tabTodo").setAttribute("aria-pressed", S.filter === "todo");
    $("tabAll").setAttribute("aria-pressed", S.filter === "all");
    if (document.activeElement !== $("q")) $("q").value = S.q;
    show("qClear", !!S.q);
    $("colHead").innerHTML = '<span class="hl">' + (picks ? "CAR · CUSTOMER" : "CAR · FLIGHT") + '</span><span class="hr">' +
      (picks ? "<span>COLL</span><span>NO SHOW</span><span>RTC</span><span>PT</span>" : "<span>SENT</span><span>CALLED</span><span>CLEAR</span>") + "</span>";
  }

  function renderCatStrip(picks) {
    var sh = sheet();
    show("catTally", picks);
    if (!picks || !sh) return;
    var n = catCounts(), set = !!sh.short_until;
    // Board strip: SHORT LEFT, LONG LEFT, SHORT, LONG (SAME DAY and NEXT DAY stay in the stats panel).
    var strip = set ? LEFT_CATS.concat(CATS.slice(2)) : LEFT_CATS.slice(0, 1);
    var cells = strip.map(function (c) {
      return '<button type="button" data-cat="' + c[0] + '" class="' + (c[2] || c[0]) + (S.catFilter === c[0] ? " on" : "") + '" aria-pressed="' + (S.catFilter === c[0]) + '"><span>' + c[1] + '</span><b class="num">' + n[c[0]] + "</b></button>";
    }).join("");
    var pick = "";
    if (can("yard")) {
      var opts = ['<option value="">' + (set ? "Clear" : "Set") + "</option>"];
      for (var i = 2; i <= 30; i++) { var k = addDaysKey(sh.day, i); opts.push('<option value="' + k + '"' + (k === sh.short_until ? " selected" : "") + ">" + dayWord(k) + "</option>"); }
      pick = '<label class="shortpick' + (set ? "" : " unset") + '"><span>SHORT TO</span><select data-shortuntil aria-label="Short dates up to">' + opts.join("") + "</select></label>";
    } else if (!set) pick = '<div class="shortpick unset"><span>SHORT TO</span><b>not set</b></div>';
    $("catTally").innerHTML = cells + pick;
  }

  function renderBoard() { return backupNudge() + renderSheet() + otherDaysHtml(); }
  // The free plan's nightly backups live inside Supabase itself: the owner is
  // reminded weekly to keep a copy of their own somewhere else.
  var BACKUP_EVERY_DAYS = 7;
  function backupNudge() {
    if (!S.me || S.me.role !== "owner" || S.platform || S.lastDownload === undefined) return "";
    var days = S.lastDownload ? Math.floor((Date.now() - Date.parse(S.lastDownload)) / 864e5) : null;
    if (days !== null && days < BACKUP_EVERY_DAYS) return "";
    return '<div class="nudge"><span>Keep your own copy of the company data: ' + (days === null ? "never downloaded yet." : "last downloaded " + days + " days ago.") +
      '</span><button type="button" class="btn ghost" data-backup>Download now</button></div>';
  }
  async function loadLastDownload() {
    if (!S.me || S.me.role !== "owner" || S.platform) return;
    var r = await sb.from("activity").select("at").eq("action", "SETTINGS").like("value", "Downloaded a backup%").order("at", { ascending: false }).limit(1);
    if (r.error) return;   // unknown: no nudge rather than a wrong one
    S.lastDownload = r.data && r.data[0] ? r.data[0].at : null;
    if (S.view === "board" && !$("panel").open) render();
  }
  // ── search: other days ──
  // Three characters or more also look at every other sheet (not removed cars),
  // so a reg typed on today's board finds it on yesterday's or on PICKS.
  var otherTimer = null;
  function searchWords() { var raw = (S.q || "").trim(); return { raw: raw.replace(/[^A-Za-z0-9 '-]/g, "").trim(), tight: raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase() }; }
  function searchOtherDays() {
    clearTimeout(otherTimer);
    var w = searchWords();
    if (w.tight.length < 3) { S.other = null; return; }
    otherTimer = setTimeout(async function () {
      var key = w.tight + "|" + S.sheetId;
      var r = await sb.from("bookings").select("id, sheet_id, kind, reg, name, make, overstay, cleared_at, intake, sheets!bookings_sheet_id_fkey(day, kind)")
        .neq("sheet_id", S.sheetId).is("removed_at", null)
        .or('reg.ilike."%' + w.tight + '%",ref.ilike."%' + w.tight + '%",phone.ilike."%' + w.tight + '%"' + (w.raw.length >= 3 ? ',name.ilike."%' + w.raw + '%"' : ""))
        .order("updated_at", { ascending: false }).limit(20);
      var now = searchWords(); if (now.tight + "|" + S.sheetId !== key) return;   // typed on since
      S.other = r.error ? null : (r.data || []).sort(function (a, b) { return ((b.sheets || {}).day || "") < ((a.sheets || {}).day || "") ? -1 : 1; });
      if (S.view === "board") $("main").innerHTML = renderBoard();
    }, 350);
  }
  function otherDaysHtml() {
    if (!S.q || !S.other || !S.other.length) return "";
    return '<div class="sec">ON OTHER DAYS <b class="num">' + S.other.length + "</b></div>" + S.other.map(function (r) {
      var sh = r.sheets || {}, st = r.kind === "picks" ? (r.intake || "LEFT") : r.cleared_at ? "DONE" : r.overstay ? "OVERSTAY" : "OUT";
      return '<button type="button" class="otherhit" data-othersheet="' + r.sheet_id + '" data-otherreg="' + esc(r.reg) + '"><b>' + esc(r.reg || "NO REG") + "</b><span>" + esc(r.name) + (r.make ? " · " + esc(r.make) : "") + "</span><i>" + esc(sheetLabel({ day: sh.day || "", kind: sh.kind || r.kind })) + " · " + st + "</i></button>";
    }).join("");
  }
  function renderSheet() {
    var sh = sheet();
    if (!sh) return '<div class="msg">No day sheets yet.' + (can("import") ? ' Open <b>☰ → Import</b> to create one from the booking site\'s download.' : " The office will import today's bookings.") + "</div>";
    var rows = visibleRows();
    var groups;
    if (sh.kind === "picks") groups = [{ title: "", cls: "", rows: rows }];
    else {
      var wait = [], main = [], over = [];
      rows.forEach(function (r) {
        if (inOverstayBlock(r)) over.push(r);
        else if (r.called_at && !r.cleared_at && !r.sent_at) wait.push(r);   // customer is there, nobody on it yet
        else main.push(r);
      });
      wait.sort(function (a, b) { return a.called_at < b.called_at ? -1 : 1; });   // longest wait first
      groups = [{ title: "NEXT IN QUEUE", cls: " hot", rows: wait }, { title: "COMING UP", cls: "", rows: main }, { title: "OVERSTAYS", cls: " old", note: overNote(over, sh), rows: over }]
        .filter(function (g) { return g.rows.length; });
    }
    if (!S.rows.length) return '<div class="msg">No cars on this sheet.</div>';
    if (!rows.length) return '<div class="msg">' + (S.filter === "todo" && !S.q && !S.yardFilter ? "Nothing outstanding." : S.q ? (S.other && S.other.length ? "Not on this sheet. Found on another day below." : searchWords().tight.length >= 3 && S.other ? "Not found on any sheet." : "Not on this sheet.") : "Nothing matches.") + "</div>";
    var draw = sh.kind === "picks" ? pickRow : dropRow;
    return groups.map(function (g) {
      return (g.title ? '<div class="sec' + g.cls + '">' + g.title + ' <b class="num">' + g.rows.length + "</b>" + (g.note ? "<span>" + g.note + "</span>" : "") + "</div>" : "") + g.rows.map(draw).join("");
    }).join("");
  }

  function yardChip(r) {
    if (!can("yard")) return r.yard ? '<span class="code ' + esc(r.yard) + '">' + esc(r.yard) + "</span>" : "";
    // The chip is the picker: one tap, choose, saved.
    return '<select class="code pick ' + (r.yard ? esc(r.yard) : "unset") + '" data-yard aria-label="Yard for ' + esc(r.reg) + '"><option value="">' + (r.yard ? "—" : "YARD") + "</option>" +
      (S.company.yards || []).map(function (y) { return "<option" + (y === r.yard ? " selected" : "") + ' value="' + esc(y) + '">' + esc(y) + "</option>"; }).join("") + "</select>";
  }
  // An early return gets its own line, like a note, so the flight line stays clear.
  // Carried from an earlier day, or marked OVERSTAY on the day it was due.
  function overNote(rows, sh) {
    var old = 0, today = 0;
    rows.forEach(function (r) { if (sh && returnDay(r) && returnDay(r) < sh.day) old++; else today++; });
    return old && today ? "earlier days · staying longer" : old ? "earlier days" : "staying longer";
  }
  function earlyLine(r) { return r.early ? '<div class="l3 early">EARLY · booked ' + esc(r.return_at ? dayShort(r.return_at) + " " + hhmm(r.return_at) : "later") + "</div>" : ""; }
  function noteLine(r) { return r.note ? '<div class="l3' + (/^!/.test(r.note) ? " bang" : "") + '">' + esc(r.note.replace(/^!\s*/, "")) + "</div>" : ""; }
  // A pressed button shows the time and the first name of whoever pressed it.
  function actBtn(r, attrs, cls, label, on, at, allowed, who) {
    var name = on && at ? staffName(who).trim().split(/\s+/)[0] : "";
    return '<button type="button" class="' + cls + (on ? " on" : "") + (label.length > 7 ? " lng" : "") + '" ' + attrs + (allowed ? "" : " disabled") + ">" +
      label + (on && at ? '<small class="num">' + esc(hhmm(at)) + "</small>" : "") + (name ? '<em class="by">' + esc(name) + "</em>" : "") + "</button>";
  }

  // The brand only ("SKODA KODIAQ SE IV PHEV SA BLUE" -> "SKODA"), for the row.
  var TWO_WORD_MAKES = /^(LAND ROVER|RANGE ROVER|ALFA ROMEO|ASTON MARTIN|MERCEDES BENZ|ROLLS ROYCE|L ROVER|DS AUTOMOBILES)\b/i;
  function makeOnly(m) {
    var s = String(m || "").trim();
    if (!s || /^[-\s.]*$/.test(s) || /^(unknown|tbc|n\/?a)\b/i.test(s)) return "";
    var two = s.match(TWO_WORD_MAKES);
    return two ? two[1] : s.split(/\s+/)[0];
  }
  // ── overstay charges (database part 23) ──
  // Booked back before the DROPS day end (06:00): free until 12:00 that day,
  // then one day's rate at once and one more at every midnight.
  // Booked back at 06:00 or later: free until 06:00 the next morning, then one
  // day's rate at once and one more at every 06:00. Counted to CLEAR, or to now.
  function overstayDue(r) {
    var rate = +(S.company && S.company.overstay_rate) || 0;
    if (!rate || r.kind !== "drops" || !r.return_at) return null;
    // A stay made longer in the booking system is charged from the first booked return.
    var ret = londonParts(new Date(r.orig_return_at || r.return_at)), end = londonParts(r.cleared_at ? new Date(r.cleared_at) : new Date());
    var dayEnd = ((S.company.drops_day_end) || "06:00").slice(0, 5);
    var dates = function (a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 86400000); }, days;
    if (ret.time < dayEnd) {
      var later = dates(ret.key, end.key);
      days = later < 0 ? 0 : later === 0 ? (end.time > "12:00" ? 1 : 0) : 1 + later;
    } else {
      // Up to and including 06:00 still belongs to the day before.
      days = dates(ret.key, end.key) - (end.time <= dayEnd ? 1 : 0);
    }
    return days > 0 ? { days: days, amount: days * rate } : null;
  }
  function money(n) { n = +n || 0; return "£" + (n % 1 ? n.toFixed(2) : n); }
  function chargeTag(r) {
    if (r.charge_method) return ' · <span class="tag pd">' + (r.charge_method === "waived" ? "WAIVED" : money(r.charge_amount) + " " + r.charge_method.toUpperCase()) + "</span>";
    var d = overstayDue(r);
    return d ? ' · <span class="tag due">' + money(d.amount) + " DUE</span>" : "";
  }
  function chargePanelHtml(r) {
    var d = overstayDue(r);
    if (!d && !r.charge_method) return "";
    var h = "<label>OVERSTAY CHARGE</label>";
    if (r.charge_method) {
      h += '<div class="chgbox pd"><b>' + (r.charge_method === "waived" ? "Waived " + money(r.charge_amount) : money(r.charge_amount) + " paid by " + r.charge_method) + "</b><span>" +
        esc(staffName(r.charge_by)) + (r.charge_at ? " · " + esc(dayShort(r.charge_at) + " " + hhmm(r.charge_at)) : "") + "</span>" +
        (can("clear") ? '<button type="button" class="link" data-chargeundo>Undo</button>' : "") + "</div>";
      return h;
    }
    h += '<div class="chgbox"><b>' + money(d.amount) + " due</b><span>" + d.days + (d.days === 1 ? " day" : " days") + " × " + money(S.company.overstay_rate) + (r.cleared_at ? "" : " · so far, still going up") + "</span></div>";
    if (can("clear")) h += '<div class="when2 chgpay"><input id="chgAmount" type="number" inputmode="decimal" min="0" step="0.01" value="' + d.amount + '" aria-label="Amount">' +
      '<button type="button" data-charge="cash">CASH</button><button type="button" data-charge="card">CARD</button><button type="button" data-charge="waived">WAIVE</button></div>';
    return h;
  }
  function recordCharge(r, method) {
    var amt = method === "" ? null : parseFloat(($("chgAmount") || {}).value);
    if (method && (isNaN(amt) || amt < 0)) return toast("Check the amount.", true);
    if (method === "waived") { var d = overstayDue(r); amt = d ? d.amount : amt; }
    run("set_overstay_paid", { p_booking: r.id, p_amount: amt, p_method: method }, r, function (x) {
      x.charge_amount = method ? amt : null; x.charge_method = method; x.charge_at = method ? nowIso() : null; x.charge_by = method ? S.me.id : null;
    });
    toast(method === "" ? "Charge cleared" : method === "waived" ? "Waived" : money(amt) + " " + method + " recorded");
  }
  // The flights check couldn't find this number among the day's arrivals, or
  // it isn't a flight number at all (TBC, …): the office needs to look.
  function flightToCheck(r) {
    if (!r.flight || r.flight === "NO FLIGHT" || r.sched_time || r.cleared_at) return false;
    return /check the flight number$/.test(r.flight_note) || !/^([A-Z0-9]{2}\d{1,5}|[A-Z]{3}\d{1,4})$/.test(r.flight);
  }
  function dropRow(r) {
    var cmpl = r.clear_word === "COMPLAINT", bang = /^!/.test(r.note), overWord = r.called_word === "Overstay";
    var canc = r.flight_status === "cancelled", over = r.overstay || overWord;
    var cls = "";
    if (cmpl || (bang && !r.cleared_at)) cls = " cmpl";
    else if (r.cleared_at) cls = " done";
    else if (over) cls = " ovst";
    else if (r.called_at) { var w = minsSince(r.called_at); cls = w > LATE_MINS ? " late" : w > WARN_MINS ? " warn" : " called"; }
    // An early return shows no booked time here (it was for another day): the EARLY tag says when.
    var booked = r.early ? r.sched_time : (r.sched_time || hhmm(r.return_at) || "—");
    var eta = canc ? "" : r.est_time;
    return '<div class="row' + cls + (S.pending[r.id] ? " busy" : "") + '" data-id="' + r.id + '">' +
      '<div class="left"><div class="l1"><button type="button" class="reg" data-open>' + esc(r.reg || "NO REG") + "</button>" + yardChip(r) +
      (r.num ? '<span class="dn num">#' + r.num + "</span>" : "") + catTag(r) + wasTag(r) + '<span class="pin">' + esc(r.name) + "</span></div>" +
      '<div class="l2 num" data-open><span class="l2a">' + (makeOnly(r.make) ? '<span class="mk">' + esc(makeOnly(r.make)) + "</span> · " : "") +
      (r.flight ? esc(r.flight) : can("flights") ? '<button type="button" class="addflight" data-addflight>+ FLIGHT</button>' : "—") + "</span>" +
      '<span class="l2b">' + (booked ? " · " + esc(booked) : "") +
      (eta ? ' &rarr; <span class="eta' + (eta === "DELAY" ? " dly" : "") + (r.flight_status === "expected" ? " exp" : "") + '">' + esc(eta) + "</span>" : "") +
      (r.flight_status === "landed" ? ' <span class="tag ld">LANDED</span>' : "") +
      (flightToCheck(r) ? ' · <span class="tag ck">CHECK FLIGHT NO.</span>' : "") +
      (canc ? ' · <span class="tag cx">CANCELLED</span>' : "") +
      (over ? ' · <span class="tag ov">OVERSTAY</span>' : "") +

      (cmpl ? ' · <span class="tag cm">COMPLAINT</span>' : "") + chargeTag(r) + "</span></div>" + earlyLine(r) + noteLine(r) + "</div>" +
      '<div class="acts">' +
      actBtn(r, 'data-act="sent"', "s", "SENT", !!r.sent_at, r.sent_at, can("sent"), r.sent_by) +
      actBtn(r, 'data-act="called"', "c" + (overWord ? " ov" : ""), overWord ? "OVERSTAY" : "CALLED", !!r.called_at, r.called_at, can("called"), r.called_by) +
      actBtn(r, 'data-act="clear"', "x" + (cmpl ? " cm" : ""), cmpl ? "COMPLAINT" : "CLEAR", !!r.cleared_at, r.cleared_at, can("clear"), r.cleared_by) +
      "</div></div>";
  }

  // Short words on the row, so the customer's name still fits on a phone.
  // DROPS: SAME DAY when the car was met on the sheet's day, NEXT DAY when it
  // was met the day before (one night away).
  function dropCat(r) {
    var sh = sheet();
    if (!sh || sh.kind !== "drops" || !r.drop_at || r.early) return "";
    var d = londonParts(new Date(r.drop_at)).key;
    return d === sh.day ? "same" : d === addDaysKey(sh.day, -1) ? "next" : "";
  }
  // Return moved to a later day in the booking system: the day it was first due back.
  function wasTag(r) {
    if (r.kind !== "drops" || !r.orig_return_at) return "";
    var d = returnDay({ return_at: r.orig_return_at });
    return d ? '<span class="cat was">WAS ' + dayWord(d) + "</span>" : "";
  }
  function catTag(r) { var c = r.kind === "drops" ? dropCat(r) : catOf(r); return c ? '<span class="cat ' + c + '">' + c.toUpperCase() + "</span>" : ""; }
  function pickRow(r) {
    var bang = /^!/.test(r.note);
    var cls = r.intake === "Collected" ? " coll" : r.intake === "No Show" ? " nosh" : r.intake === "RTC" ? " rtc" : bang ? " cmpl" : "";
    function b(v, c, label, perm) { return actBtn(r, 'data-pick="' + v + '"', c, label, r.intake === v, r.intake_at, can("intake") && (!perm || can(perm)), r.intake_by); }
    return '<div class="row' + cls + (S.pending[r.id] ? " busy" : "") + '" data-id="' + r.id + '">' +
      '<div class="left"><div class="l1"><button type="button" class="reg" data-open>' + esc(r.reg || "NO REG") + "</button>" +
      (r.num ? '<span class="dn num">#' + r.num + "</span>" : "") + catTag(r) + '<span class="pin">' + esc(r.name) + "</span></div>" +
      // Just the make on the row; the full car and booking ref are in the car's panel.
      '<div class="l2 num" data-open><span class="l2a">' + (makeOnly(r.make) ? '<span class="mk">' + esc(makeOnly(r.make)) + "</span> · " : "") + "drop " + esc(hhmm(r.drop_at) || "—") + (r.pick_called ? ' · <span class="tag' + (r.pick_called === "New Booking" ? ' nb">NEW BOOKING' : '">' + esc(r.pick_called)) + "</span> " + esc(hhmm(r.pick_called_at)) : "") + "</span></div>" +
      noteLine(r) + "</div>" +
      '<div class="acts">' + b("Collected", "k", "COLL") + b("No Show", "n", "NO SHOW") + b("RTC", "r", "RTC", "rtc") +
      actBtn(r, "data-pt", "p", "PT", !!r.pt_at, r.pt_at, can("intake"), r.pt_by) + "</div></div>";
  }

  function rowOf(el) { var c = el.closest("[data-id]"); return c ? S.rows.filter(function (r) { return r.id === c.dataset.id; })[0] : null; }
  function nowIso() { return new Date().toISOString(); }

  function tapDrop(r, action, word) {
    var field = { sent: "sent_at", called: "called_at", clear: "cleared_at" }[action];
    var on = word ? !(r[field] && (action === "called" ? r.called_word : r.clear_word) === word) : !r[field];
    run("tap_drop", { p_booking: r.id, p_action: action, p_on: on, p_word: word || "" }, r, function (x) {
      if (action === "sent") {
        if (on) { x.yard_before_t = x.yard; x.yard = "T"; x.sent_at = nowIso(); x.sent_by = S.me.id; }
        else { if (x.yard === "T" && x.yard_before_t) x.yard = x.yard_before_t; x.yard_before_t = ""; x.sent_at = null; x.sent_by = null; }
      } else if (action === "called") {
        x.called_word = on ? (word || "Called") : ""; x.called_at = on ? nowIso() : null; x.called_by = on ? S.me.id : null;
        if (on && word === "Overstay") x.overstay = true;
      } else {
        x.clear_word = on ? (word || "Collected") : ""; x.cleared_at = on ? nowIso() : null; x.cleared_by = on ? S.me.id : null;
      }
    });
    // CALLED on a car booked back on a later day: they're coming back early,
    // so offer to move it onto tonight's sheet there and then.
    if (action === "called" && on && !word && canEarly(r)) {
      var sh = S.sheets.filter(function (x) { return x.id === r.sheet_id; })[0];
      setTimeout(function () {
        if (confirm((r.reg || "This car") + " is booked back " + sheetLabel(sh) + ". Coming back early?\n\nOK moves it to tonight's sheet (" + sheetLabel({ kind: "drops", day: currentShiftKey() }) + ")."))
          earlyMove(r, { disabled: false }, false, true);
      }, 50);
    }
  }
  // PT: photos taken in the app's camera (quickest) or picked from the gallery.
  // Two ways to get them to PT, chosen in Settings (companies.pt_method):
  //   photos  the reg goes to the PT WhatsApp chat, then the photos in albums
  //           (10 at a time on Android). Kept on the phone until all are sent,
  //           so a reload while WhatsApp is open carries on where it left off.
  //   link    they upload in the background as they come in, then WhatsApp
  //           opens once with the reg and a link to every photo (part 25).
  // 2400 px at 85% is about a third of a full camera photo to upload, and
  // still sharper than WhatsApp's own HD.
  var pt = null, PT_MAX = 2400, PT_Q = 0.85, PT_AT_ONCE = 4;
  function ptCaption(r) { return r.reg || "NO REG"; }
  function ptToken() {
    var b = new Uint8Array(18); crypto.getRandomValues(b);
    return btoa(String.fromCharCode.apply(null, b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function ptLink() { return location.origin + "/p/" + pt.token; }
  function ptMessage(r) { var n = ptCount("done"); return ptCaption(r) + " – " + n + " PT photo" + (n === 1 ? "" : "s") + ": " + ptLink(); }
  function ptCount(state) { return pt ? pt.items.filter(function (x) { return !state || x.state === state; }).length : 0; }
  function openPt(r) {
    if (!pt || pt.id !== r.id) { ptClear(); pt = { id: r.id, reg: ptCaption(r), mode: S.company && S.company.pt_method === "link" ? "link" : "photos", token: ptToken(), items: [], saved: 0, sent: 0 }; }
    panelRow = r;
    if (pt.mode === "photos") return openPtPhotos(r);
    var num = (S.company && S.company.pt_whatsapp) || "", n = pt.items.length, ready = ptReady();
    var pick = '<input type="file" accept="image/*" multiple data-ptfile hidden>';
    $("panelBody").innerHTML = '<h2 id="panelTitle">PT · ' + esc(r.reg || "NO REG") + (r.num ? " <small>#" + r.num + "</small>" : "") + "</h2>" +
      '<button type="button" class="btn ' + (n ? "ghost" : "brand") + ' ptgo" data-ptcam>' + (n ? "+ TAKE MORE" : "TAKE PHOTOS") + "</button>" +
      '<label class="btn ghost ptpick">' + pick + (n ? "+ Add from gallery" : "Choose from gallery") + "</label>" +
      (n ? '<div class="ptthumbs" id="ptThumbs">' + pt.items.map(function (x, i) { return ptImg(x, ' data-pti="' + i + '" class="' + x.state + '"'); }).join("") + "</div>" : "") +
      '<p class="hint" id="ptStatus">' + ptStatusText() + "</p>" +
      (ready ? (num
          ? '<a class="btn brand ptgo" href="https://wa.me/' + esc(num) + "?text=" + encodeURIComponent(ptMessage(r)) + '" target="_blank" rel="noopener" data-ptlink>SEND TO PT ON WHATSAPP</a>'
          : '<button type="button" class="btn brand ptgo" data-ptlinkshare>SEND TO PT ON WHATSAPP</button>')
        : n ? '<button type="button" class="btn brand ptgo" disabled data-keepoff>' + (ptCount("fail") ? "Some photos didn't upload" : pt.saveFail ? "Link not saved yet" : "Uploading…") + "</button>" : "") +
      ((ptCount("fail") || pt.saveFail) && !ptCount("wait") && !ptCount("up") ? '<button type="button" class="btn ghost ptgo" data-ptretry>Try again' + (ptCount("fail") ? " (" + ptCount("fail") + ")" : "") + "</button>" : "") +
      '<div class="pbtns"><button type="button" data-close>Close</button>' + (n ? '<button type="button" data-ptclear>Start again</button>' : "") + "</div>" +
      '<button type="button" class="link" data-ptmark>Tick PT without sending photos</button>';
    if (!$("panel").open) $("panel").showModal();
  }
  function ptReady() { return !!pt && pt.items.length > 0 && ptCount("done") === pt.items.length && pt.saved === pt.items.length; }
  function ptStatusText() {
    if (!pt || !pt.items.length) return "";
    var n = pt.items.length, d = ptCount("done"), f = ptCount("fail");
    if (ptReady()) return "✓ " + n + " photo" + (n === 1 ? "" : "s") + " uploaded. Tap Send, then Send again in WhatsApp.";
    if (f && d + f === n) return d + " of " + n + " uploaded. " + f + " didn't upload: check the signal and try again.";
    if (pt.saveFail && d === n) return "✓ All " + n + " photos are up, but the link didn't save. Trying again… or tap Try again.";
    return "Uploading " + (d + 1 > n ? n : d + 1) + " of " + n + "… keep this screen open.";
  }
  // Update the thumbnails and the button in place while uploading, or redraw
  // the panel once everything's in.
  function ptRefresh() {
    var cc = $("camCount"); if (cc) { cc.textContent = camCountText(); return; }
    if (pt && pt.mode === "photos") { if ($("panel").open && panelRow && panelRow.id === pt.id) openPt(panelRow); return; }
    if (!pt || !$("panel").open || !panelRow || panelRow.id !== pt.id) return;
    if (ptReady() || (!ptCount("wait") && !ptCount("up"))) return openPt(panelRow);
    pt.items.forEach(function (x, i) { var im = $("panelBody").querySelector('[data-pti="' + i + '"]'); if (im) im.className = x.state; });
    var s = $("ptStatus"); if (s) s.textContent = ptStatusText();
  }
  function ptAdd(input) {
    var r = panelRow; if (!pt || !r) return;
    Array.prototype.forEach.call(input.files || [], function (f) {
      pt.items.push({ file: f, url: "", state: pt.mode === "photos" ? "prep" : "wait", n: pt.items.length + 1 });
    });
    input.value = "";
    openPt(r); ptPump(r);
  }
  // Full camera photos are 4-8 MB; 3000 px is sharper than anyone zooms into
  // and a lot quicker to upload on mobile data.
  // Gallery photos: made upload size and stamped with when they were taken.
  async function ptShrink(b, reg) {
    try {
      var when = await ptTakenAt(b);
      var im = await createImageBitmap(b), k = Math.min(1, PT_MAX / Math.max(im.width, im.height));
      var c = document.createElement("canvas"); c.width = Math.round(im.width * k); c.height = Math.round(im.height * k);
      var g = c.getContext("2d"); g.drawImage(im, 0, 0, c.width, c.height); if (im.close) im.close();
      ptStamp(g, c.width, c.height, when, reg);
      return await new Promise(function (ok) { c.toBlob(function (x) { ok(x || b); }, "image/jpeg", PT_Q); });
    } catch (e) { return b; }
  }
  // Date, time and reg burnt into the bottom corner of the photo, so it stays
  // with the photo in WhatsApp, downloads and the app's copy.
  function ptStampText(when, reg) {
    var t = new Date(when).toLocaleString("en-GB", { timeZone: TZ, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).replace(",", "");
    return t + (reg ? " · " + reg : "");
  }
  function ptStamp(g, w, h, when, reg) {
    try {
      var text = ptStampText(when, reg), size = Math.max(14, Math.round(Math.min(w, h) * 0.045)), pad = Math.round(size * 0.45);
      g.font = "700 " + size + "px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
      var tw = g.measureText(text).width, bw = tw + pad * 2, bh = size + pad * 2;
      g.fillStyle = "rgba(0,0,0,.55)"; g.fillRect(w - bw - pad, h - bh - pad, bw, bh);
      g.fillStyle = "#fff"; g.textBaseline = "middle"; g.fillText(text, w - bw, h - pad - bh / 2);
    } catch (e) {}
  }
  // When a gallery photo was taken: the camera's own date in the photo (EXIF
  // DateTimeOriginal, UK local time); failing that, the file's date.
  async function ptTakenAt(f) {
    var fallback = f.lastModified || Date.now();
    try {
      if (!/jpe?g/i.test(f.type || f.name || "")) return fallback;
      var v = new DataView(await f.slice(0, 131072).arrayBuffer());
      if (v.getUint16(0) !== 0xFFD8) return fallback;
      for (var o = 2; o + 4 < v.byteLength;) {
        var mk = v.getUint16(o), len = v.getUint16(o + 2);
        if (mk === 0xFFE1 && v.getUint32(o + 4) === 0x45786966) return ptExifDate(v, o + 10) || fallback;
        if ((mk & 0xFF00) !== 0xFF00) break;
        o += 2 + len;
      }
    } catch (e) {}
    return fallback;
  }
  function ptExifDate(v, t) {
    var le = v.getUint16(t) === 0x4949, u16 = function (p) { return v.getUint16(p, le); }, u32 = function (p) { return v.getUint32(p, le); };
    function find(ifd, tag) { var n = u16(ifd); for (var i = 0; i < n; i++) { var e = ifd + 2 + i * 12; if (u16(e) === tag) return e; } return 0; }
    var ifd0 = t + u32(t + 4), ex = find(ifd0, 0x8769), e = ex ? find(t + u32(ex + 8), 0x9003) : 0;
    if (!e) e = find(ifd0, 0x0132);
    if (!e) return 0;
    var at = t + u32(e + 8), str = "";
    for (var i = 0; i < 19; i++) str += String.fromCharCode(v.getUint8(at + i));
    var m = str.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/); if (!m) return 0;
    // The camera's clock is UK local time: find the moment that shows that in London.
    var guess = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    var shown = new Date(guess).toLocaleString("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false });
    var off = (+shown % 24 - +m[4] + 24) % 24; if (off > 12) off -= 24;
    return guess - off * 3600000;
  }
  function ptPump(r) {
    var cur = pt; if (!cur) return;
    if (cur.mode === "photos") return ptPrep(r, cur);
    while (ptCount("up") < PT_AT_ONCE) {
      var x = cur.items.filter(function (y) { return y.state === "wait"; })[0]; if (!x) break;
      x.state = "up"; ptUpload(r, cur, x);
    }
    // The link is saved once shooting's finished (Done), not after every photo.
    if (!camStream && !ptCount("wait") && !ptCount("up") && ptCount("done") > cur.saved) ptSave(r, cur);
  }
  async function ptUpload(r, cur, x) {
    try {
      var b = x.ready ? x.file : await ptShrink(x.file, cur.reg);
      if (!x.url) { x.url = await ptThumbOf(b); var im0 = $("panelBody").querySelector('[data-pti="' + (x.n - 1) + '"]'); if (im0 && x.url) im0.src = x.url; }
      var ext = b.type === "image/png" ? "png" : b.type === "image/jpeg" ? "jpg" : (x.file.name.split(".").pop() || "jpg").toLowerCase();
      x.path = S.me.company_id + "/" + r.id + "/" + cur.token + "/" + String(x.n).padStart(2, "0") + "." + ext;
      var up = await sb.storage.from("pt-photos").upload(x.path, b, { contentType: b.type || "image/jpeg" });
      // "Already exists" on a retry means the first try got there after all.
      x.state = !up.error || /exist|duplicate/i.test(up.error.message || "") ? "done" : "fail";
      if (x.state === "fail") x.err = up.error.message;
    } catch (e) { x.state = "fail"; x.err = e.message; }
    if (pt !== cur) return;
    ptRefresh(); ptPump(r);
  }
  async function ptSave(r, cur) {
    if (cur.saving) return;
    cur.saving = true;
    var paths = cur.items.filter(function (x) { return x.state === "done"; }).map(function (x) { return x.path; });
    var res; try { res = await sb.rpc("pt_link_save", { p_token: cur.token, p_booking: r.id, p_paths: paths }); } catch (e) { res = { error: e }; }
    cur.saving = false;
    if (pt !== cur) return;
    if (res.error) {
      cur.saveFail = true;
      toast("Couldn't save the link yet: " + (isDown(res) ? "no signal or the server is busy." : res.error.message), true);
      setTimeout(function () { if (pt === cur && cur.saveFail) { cur.saveFail = false; ptSave(r, cur); } }, 8000);
      return ptRefresh();   // redraws only if this car's PT screen is open
    }
    cur.saveFail = false;
    cur.saved = paths.length;
    if (ptCount("fail")) { var f = cur.items.filter(function (x) { return x.state === "fail"; })[0]; if (f && f.err) toast("Upload failed: " + f.err, true); }
    ptRefresh();
  }
  // In-app camera for speed: one tap per photo, as fast as you like, and each
  // photo starts uploading straight away while you take the next.
  // If the phone refuses (no permission, old browser) the PT screen is there
  // to choose photos from the gallery instead.
  var camStream = null, camTorch = false;
  function camLight(on) {
    var track = camStream && camStream.getVideoTracks()[0]; if (!track) return Promise.resolve();
    return track.applyConstraints({ advanced: [{ torch: on }] });
  }
  async function camToggleTorch() {
    var want = !camTorch;
    try { await camLight(want); camTorch = want; }
    catch (e) { return toast("This phone won't let the app use its light.", true); }
    var b = $("camTorch"); if (b) { b.textContent = "⚡ FLASH " + (camTorch ? "ON" : "OFF"); b.classList.toggle("on", camTorch); b.setAttribute("aria-pressed", camTorch); }
  }
  // iPhones ask for camera permission every time the camera is started again,
  // so there the camera is parked (kept running, off screen) for a few minutes
  // after Done and picked up again by the next PT: one question, not one per car.
  var IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var camParked = null, camParkTimer = null, CAM_PARK_MS = 5 * 60000;
  function camLive(st) { return !!st && st.getVideoTracks().some(function (t) { return t.readyState === "live"; }); }
  function camUnpark() {
    clearTimeout(camParkTimer);
    if (camParked) camParked.getTracks().forEach(function (t) { t.stop(); });
    camParked = null;
  }
  async function ptCamera(r) {
    try {
      if (camLive(camParked)) { clearTimeout(camParkTimer); camStream = camParked; camParked = null; }
      else {
        camUnpark();
        camStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 } } });
      }
    } catch (e) {
      toast(e && e.name === "NotAllowedError"
        ? (IS_IOS ? "Camera not allowed. Tap Allow when asked, or in Safari tap aA › Website Settings › Camera › Allow." : "Camera not allowed. Allow it in the browser's site settings, or choose photos from the gallery.")
        : "The camera wouldn't start. Choose photos from the gallery instead.", true);
      return;
    }
    $("panel").classList.add("cam");
    $("panelBody").innerHTML = '<div class="camview"><video id="camVideo" autoplay playsinline muted></video><div class="camflash" id="camFlash"></div><div class="camring" id="camRing"></div><button type="button" class="camtorch hidden" id="camTorch" data-camtorch aria-pressed="false">⚡ FLASH OFF</button></div>' +
      '<div class="cambar"><span class="camcount" id="camCount">' + camCountText() + '</span><button type="button" class="shutter" data-shutter aria-label="Take photo"></button><button type="button" class="camdone" data-camdone>Done</button></div>';
    $("camVideo").srcObject = camStream;
    // Keep the picture sharp as the phone moves round the car.
    var track = camStream.getVideoTracks()[0], caps = track && track.getCapabilities ? track.getCapabilities() : {};
    if (caps.focusMode && caps.focusMode.indexOf("continuous") !== -1) track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(function () {});
    // The phone's light, for dark corners of the terminal. Stays on while shooting.
    camTorch = false;
    if (caps.torch) show("camTorch", true);
  }
  // Tap the picture to focus on that spot (where the phone allows it).
  function camFocus(e) {
    var v = $("camVideo"), track = camStream && camStream.getVideoTracks()[0]; if (!v || !track) return;
    var caps = track.getCapabilities ? track.getCapabilities() : {}; if (!caps.pointsOfInterest && !caps.focusMode) return;
    var b = v.getBoundingClientRect(), x = (e.clientX - b.left) / b.width, y = (e.clientY - b.top) / b.height;
    var c = { pointsOfInterest: [{ x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }] };
    if (caps.focusMode && caps.focusMode.indexOf("continuous") !== -1) c.focusMode = "continuous";
    track.applyConstraints({ advanced: [c] }).catch(function () {});
    var ring = $("camRing"); if (ring) { ring.style.left = (e.clientX - b.left) + "px"; ring.style.top = (e.clientY - b.top) + "px"; ring.classList.remove("go"); void ring.offsetWidth; ring.classList.add("go"); }
  }
  $("panel").addEventListener("pointerdown", function (e) { if (e.target && e.target.id === "camVideo") camFocus(e); });
  function camCountText() {
    var n = pt ? pt.items.length : 0, d = ptCount("done");
    return n + " photo" + (n === 1 ? "" : "s") + (n && pt.mode === "link" ? " · " + d + " uploaded" : "");
  }
  function camStop() {
    var cur = camStream ? pt : null;
    // However the camera was closed (Done, Back, a tap outside), what was shot
    // carries on: the link (or the app's copy) is saved once shooting stops.
    if (cur) setTimeout(function () {
      if (pt !== cur) return;
      var row = S.rows.filter(function (x) { return x.id === cur.id; })[0] || { id: cur.id, reg: cur.reg };
      if (cur.mode === "photos") ptStore();
      ptPump(row);
    }, 0);
    if (camStream) {
      if (camTorch) camLight(false).catch(function () {});
      if (IS_IOS && camLive(camStream)) { camParked = camStream; clearTimeout(camParkTimer); camParkTimer = setTimeout(camUnpark, CAM_PARK_MS); }
      else camStream.getTracks().forEach(function (t) { t.stop(); });
    }
    camStream = null; camTorch = false; $("panel").classList.remove("cam");
  }
  // The picture on screen, saved at upload size in one go (no second squeeze).
  function ptShoot(r) {
    var v = $("camVideo"); if (!v || !v.videoWidth || !pt) return;
    var f = $("camFlash"); if (f) { f.classList.remove("go"); void f.offsetWidth; f.classList.add("go"); }
    var k = Math.min(1, PT_MAX / Math.max(v.videoWidth, v.videoHeight));
    var c = document.createElement("canvas"); c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k);
    var g = c.getContext("2d"); g.drawImage(v, 0, 0, c.width, c.height);
    ptStamp(g, c.width, c.height, Date.now(), pt.reg);
    var cur = pt, thumb = ptThumb(c, c.width, c.height);
    c.toBlob(function (b) {
      if (!b || pt !== cur) return;
      cur.items.push({ file: b, url: thumb, state: cur.mode === "photos" ? "local" : "wait", n: cur.items.length + 1, ready: true });
      var el = $("camCount"); if (el) el.textContent = camCountText();
      ptPump(r);
    }, "image/jpeg", PT_Q);
  }
  function ptRetry(r) { pt.saveFail = false; pt.items.forEach(function (x) { if (x.state === "fail") x.state = "wait"; }); openPt(r); ptPump(r); }
  // WhatsApp is open with the message: PT is done.
  function ptSent(r) {
    r = S.rows.filter(function (x) { return x.id === r.id; })[0] || r;
    if (!r.pt_at) tapPick(r, "pt");
    toast(ptCaption(r) + ": PT link sent, PT ticked");
    setTimeout(function () { ptClear(); if ($("panel").open) $("panel").close(); }, 300);
  }
  function ptClear() { pt = null; }
  // Small previews (240 px) for the tiles: fifty full-size photos on screen
  // would need close to a gigabyte and cheaper phones would close the app.
  var PT_THUMB = 240;
  function ptThumb(src, w, h) {
    try {
      var k = PT_THUMB / Math.max(w, h), c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
      c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", 0.7);
    } catch (e) { return ""; }
  }
  async function ptThumbOf(blob) {
    try { var im = await createImageBitmap(blob), t = ptThumb(im, im.width, im.height); if (im.close) im.close(); return t; } catch (e) { return ""; }
  }
  function ptImg(x, attrs) { return "<img" + (x.url ? ' src="' + x.url + '"' : "") + ' alt="" decoding="async"' + (attrs || "") + ">"; }

  // ── PT the WhatsApp-photos way ──
  var PT_BATCH = 10;
  var BIG_SHARE = IS_IOS;
  function openPtPhotos(r) {
    var num = (S.company && S.company.pt_whatsapp) || "", reg = ptCaption(r), n = pt.items.length, prep = ptCount("prep"), sent = pt.sent || 0;
    var b = ptBatch(), pick = '<input type="file" accept="image/*" multiple data-ptfile hidden>';
    // The way chosen in Settings: every photo in one PDF (one tap), or the
    // photos themselves (reg first, then 10 at a time on Android). If the PDF
    // can't be made on this phone, the photos way is there instead.
    var pdfWay = ptWantsPdf() && n && !prep && !sent && !pt.regSent, pdf = pdfWay ? ptPdfState() : null;
    if (pdf && pdf.failed) pdfWay = false;
    var regBtn = num ? '<a class="btn brand ptgo" href="https://wa.me/' + esc(num) + "?text=" + encodeURIComponent(reg) + '" target="_blank" rel="noopener" data-ptreg>1 · SEND ' + esc(reg) + " TO PT</a>"
      : '<button type="button" class="btn brand ptgo" data-ptregshare>1 · SEND ' + esc(reg) + " TO PT</button>";
    var step1 = !n || prep ? ""
      : pdfWay ? '<button type="button" class="btn brand ptgo" data-ptpdf' + (pdf.ready ? "" : " disabled data-keepoff") + ">" + esc(pdf.label) + "</button>" +
          '<p class="hint">Every photo in one file, with ' + esc(reg) + " as the message. Pick the PT chat and Send; PT ticks itself.</p>"
      : !pt.regSent ? regBtn
      : b ? '<button type="button" class="btn brand ptgo" data-ptshare>2 · ' + esc(ptShareLabel()) + "</button>" : "";
    // The send buttons come first, so they're never below a screenful of photos.
    var hint = '<p class="hint">' + (!n ? "" : prep ? "Getting " + prep + " photo" + (prep === 1 ? "" : "s") + " ready…"
        : pdfWay ? ""
        : !pt.regSent ? (ptWantsPdf() ? "The PDF couldn't be made, so send them as photos: " : "") + "opens the PT chat with " + esc(reg) + " typed; Send, come back, then the photos."
        : sent ? "Keep going: tap the button, pick the PT chat (top of the list), Send."
        : "Tap the button, pick the PT chat (top of the list), then Send. PT ticks itself.") + "</p>";
    $("panelBody").innerHTML = '<h2 id="panelTitle">PT · ' + esc(reg) + (r.num ? " <small>#" + r.num + "</small>" : "") + "</h2>" +
      (n && (pt.regSent || sent) ? '<div class="ptsteps"><span class="' + (pt.regSent ? "ok" : "") + '">' + (pt.regSent ? "✓" : "1") + " Reg</span><span class=\"" + (sent && sent >= n ? "ok" : "") + '">' + (sent >= n && n ? "✓" : "2") + " Photos " + sent + "/" + n + "</span></div>" : "") +
      step1 + hint +
      (sent || pt.pdfSent ? "" : '<button type="button" class="btn ' + (n ? "ghost" : "brand") + ' ptgo" data-ptcam>' + (n ? "+ TAKE MORE" : "TAKE PHOTOS") + "</button>" +
        '<label class="btn ghost ptpick">' + pick + (n ? "+ Add from gallery" : "Choose from gallery") + "</label>") +
      (n ? '<div class="ptthumbs">' + pt.items.map(function (x, i) { return ptImg(x, i < sent ? ' class="sent"' : x.state === "prep" ? ' class="wait"' : ""); }).join("") + "</div>" : "") +
      '<div class="pbtns"><button type="button" data-close>Close</button>' + (n ? '<button type="button" data-ptclear>Start again</button>' : "") + "</div>" +
      '<button type="button" class="link" data-ptmark>Tick PT without sending photos</button>';
    if (!$("panel").open) $("panel").showModal();
  }
  // Gallery photos are 4-8 MB each: made the same size as camera shots first,
  // so WhatsApp takes them quickly and the phone doesn't run out of memory.
  async function ptPrep(r, cur) {
    if (cur.prepping) return;
    cur.prepping = true;
    var x;
    while ((x = cur.items.filter(function (y) { return y.state === "prep"; })[0])) {
      x.file = await ptShrink(x.file, cur.reg); x.url = x.url || await ptThumbOf(x.file); x.state = "local";
      if (pt !== cur) return;
    }
    cur.prepping = false;
    // The copy starts once shooting's finished, so it's saved as one set.
    if (!camStream) bkQueueSet(cur.id, cur.token, cur.items.filter(function (y) { return y.state === "local"; }));
    ptStore(); ptRefresh();
  }

  // ── The copy kept for the app ──
  // In the WhatsApp-chat way a copy of the photos uploads quietly in the
  // background, so the car's panel can show them. PT still gets every full
  // photo on WhatsApp. The copy is small, about 35 KB a photo (800 px).
  // Where it goes is companies.pt_copy_store:
  //   "r2"        Cloudflare R2 (10 GB free): every photo, kept 30 days. The
  //               pt-r2 function hands out upload addresses; paths start "r2:".
  //   otherwise   Supabase's store (1 GB on the free plan): 10 photos spread
  //               evenly round the car.
  // It waits while the camera is open or PT's photos are still being sent:
  // making copies alongside the share sheet stopped PT on an iPhone.
  var BK = [], bkActive = 0, BK_TRIES = 4, BK_MAX = 800, BK_Q = 0.5, BK_KEEP = 10;
  // Returns { blob, how }: "bitmap" or "img" (made small), "orig" (couldn't be).
  async function bkSmall(f) {
    async function draw(src, w, h) {
      var k = Math.min(1, BK_MAX / Math.max(w, h));
      var c = document.createElement("canvas"); c.width = Math.round(w * k); c.height = Math.round(h * k);
      c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
      var b = await new Promise(function (ok) { c.toBlob(ok, "image/jpeg", BK_Q); });
      c.width = c.height = 0;   // free the canvas memory at once (iPhones are strict about it)
      return b && b.size < f.size ? b : null;
    }
    try {
      var im = await createImageBitmap(f), b1 = await draw(im, im.width, im.height); if (im.close) im.close();
      if (b1) return { blob: b1, how: "bitmap" };
    } catch (e) {}
    var url = "";
    try {
      url = URL.createObjectURL(f);
      var img = new Image(); img.src = url;
      await (img.decode ? img.decode() : new Promise(function (ok, no) { img.onload = ok; img.onerror = no; }));
      var b2 = await draw(img, img.naturalWidth, img.naturalHeight);
      if (b2) return { blob: b2, how: "img" };
    } catch (e) {} finally { if (url) URL.revokeObjectURL(url); }
    return { blob: f, how: "orig" };
  }
  // In the store's cache setting, so a phone's copies can be checked: small or not.
  var BK_MARK = { bitmap: "3600", img: "3601", orig: "3602" };
  // The photos of a set kept as the copy: BK_KEEP of them, first to last.
  function bkR2() { return !!(S.company && S.company.pt_copy_store === "r2"); }
  function bkPath(rowId, token, n) { return (bkR2() ? "r2:" : "") + S.me.company_id + "/" + rowId + "/" + token + "/" + String(n).padStart(2, "0") + ".jpg"; }
  function bkPick(items) {
    var ns = items.map(function (x) { return x.n; }).sort(function (a, b) { return a - b; }), keep = {};
    if (bkR2() || ns.length <= BK_KEEP) { ns.forEach(function (n) { keep[n] = true; }); return keep; }
    for (var k = 0; k < BK_KEEP; k++) keep[ns[Math.round(k * (ns.length - 1) / (BK_KEEP - 1))]] = true;
    return keep;
  }
  function bkQueueSet(rowId, token, items) {
    var keep = bkPick(items);
    items.forEach(function (x) { if (keep[x.n]) bkQueue(rowId, token, x); else if (x.bk !== "done") { x.bk = "skip"; x.queued = true; } });
    // Every kept photo already up (from before a reload): save the set now.
    var mine = items.filter(function (x) { return keep[x.n]; });
    if (mine.length && mine.every(function (x) { return x.bk === "done"; })) {
      BK = BK.filter(function (y) { return y.token !== token; });
      bkSave(rowId, token, mine.map(function (x) { return x.path || bkPath(rowId, token, x.n); }), true, 0);
    }
  }
  function bkHold() { return !!camStream || !!(pt && pt.mode === "photos" && $("panel").open && (pt.sent || 0) < pt.items.length); }
  // Photos already up (before a reload) join the set too, so it's saved whole.
  function bkQueue(rowId, token, x) {
    if (x.queued) return;
    x.queued = true;
    x.path = bkPath(rowId, token, x.n);
    if (x.bk !== "done") x.bk = "wait";
    BK.push({ row: rowId, token: token, x: x }); bkPump();
  }
  function bkPump() {
    if (bkHold()) return;
    while (bkActive < (IS_IOS ? 1 : 2)) {
      var j = BK.filter(function (y) { return y.x.bk === "wait"; })[0]; if (!j) break;
      j.x.bk = "up"; bkActive++; bkUpload(j);
    }
  }
  async function bkUpload(j) {
    var x = j.x;
    try {
      var small = await bkSmall(x.file);
      if (/^r2:/.test(x.path)) {
        var put = await timedFetch(await bkR2Url(j), { method: "PUT", body: small.blob, headers: { "Content-Type": "image/jpeg" } });
        x.bk = put.ok ? "done" : "fail";
        if (put.status === 403) delete R2URLS[j.token];   // address too old: ask again
      } else {
        var up = await sb.storage.from("pt-photos").upload(x.path, small.blob, { contentType: "image/jpeg", cacheControl: BK_MARK[small.how] });
        x.bk = !up.error || /exist|duplicate/i.test(up.error.message || "") ? "done" : "fail";
      }
    } catch (e) { x.bk = "fail"; }
    bkActive--;
    if (x.bk === "fail") { x.tries = (x.tries || 0) + 1; if (x.tries < BK_TRIES) setTimeout(function () { if (x.bk === "fail") { x.bk = "wait"; bkPump(); } }, 5000 * x.tries); }
    var mine = BK.filter(function (y) { return y.token === j.token; });
    if (mine.length && mine.every(function (y) { return y.x.bk === "done" || (y.x.bk === "fail" && y.x.tries >= BK_TRIES); })) {
      BK = BK.filter(function (y) { return y.token !== j.token; });
      var paths = mine.filter(function (y) { return y.x.bk === "done"; }).map(function (y) { return y.x.path; });
      bkSave(j.row, j.token, paths, paths.length === mine.length, 0);
    }
    bkPump();
  }
  // R2 upload addresses, asked for once per car (they last 15 minutes; asked
  // again after 10, or when one is missing or refused).
  var R2URLS = {};
  async function bkR2Url(j) {
    var name = j.x.path.split("/").pop(), c = R2URLS[j.token];
    if (!c || Date.now() - c.at > 10 * 60000) {
      var names = [name].concat(BK.filter(function (y) { return y.token === j.token && y.x.bk !== "done"; }).map(function (y) { return y.x.path.split("/").pop(); }).filter(function (n) { return n !== name; })).slice(0, 60);
      c = R2URLS[j.token] = { at: Date.now(), p: callFunction("pt-r2", { action: "upload", booking: j.row, token: j.token, names: names }, true).then(function (d) { return d.urls || {}; }) };
    }
    var urls;
    try { urls = await c.p; } catch (e) { if (R2URLS[j.token] === c) delete R2URLS[j.token]; throw e; }
    if (!urls[name]) { if (R2URLS[j.token] === c) delete R2URLS[j.token]; throw new Error("No upload address."); }
    return urls[name];
  }
  // The set is saved as one link; until that has worked the phone keeps its copy
  // (tried again a few times, then again next time the app opens).
  var BK_SAVED = {};
  async function bkSave(rowId, token, paths, allUp, tries) {
    if (paths.length) {
      var res; try { res = await sb.rpc("pt_link_save", { p_token: token, p_booking: rowId, p_paths: paths }); } catch (e) { res = { error: e }; }
      if (res.error) { if (tries < 5) setTimeout(function () { bkSave(rowId, token, paths, allUp, tries + 1); }, 5000 * Math.pow(2, tries)); return; }
    }
    if (allUp) BK_SAVED[token] = true;
    bkFinished(rowId, allUp);
  }
  // Everything for that car is up and saved: forget the phone's copy once all are sent too.
  async function bkFinished(rowId, allUp) {
    if (pt && pt.id === rowId) return ptStore();
    var rec = (await ptSaved()).filter(function (x) { return x.id === rowId; })[0];
    if (allUp && rec && rec.sent >= (rec.blobs || []).length) ptForget(rowId);
  }
  function bkPending(p) { return !BK_SAVED[p.token] || p.items.some(function (x) { return x.state === "local" && x.bk !== "done" && x.bk !== "skip"; }); }
  function ptBatch() {
    if (!pt) return null;
    var left = pt.items.slice(pt.sent || 0).filter(function (x) { return x.state === "local"; });
    if (!left.length) return null;
    return BIG_SHARE ? left : left.slice(0, PT_BATCH);
  }
  function ptShareLabel() {
    var b = ptBatch(), n = pt.items.length; if (!b) return "";
    if (b.length === n) return "SEND " + n + " PHOTO" + (n === 1 ? "" : "S");
    var from = (pt.sent || 0) + 1;
    return "SEND PHOTOS " + from + "–" + (from + b.length - 1) + " OF " + n;
  }
  function ptFiles(batch) {
    var reg = (pt.reg || "car").replace(/\s+/g, "");
    return batch.map(function (x) { return x.file instanceof File ? x.file : new File([x.file], reg + "-" + x.n + ".jpg", { type: x.file.type || "image/jpeg" }); });
  }
  // Photos only: text shared with photos lands on every one and stops WhatsApp
  // grouping them into an album. PT is ticked as the first photos go (the tick
  // is saved on the phone at once), and unticked if that first share is cancelled.
  async function ptShare(r, btn) {
    var batch = ptBatch(); if (!batch) return;
    var files = ptFiles(batch);
    try { await navigator.clipboard.writeText(ptCaption(r)); } catch (e) {}
    if (!navigator.canShare || !navigator.canShare({ files: files })) return toast("This phone can't pass photos to WhatsApp from the app. Send them from WhatsApp; the reg is copied.", true);
    btn.disabled = true;
    var row = S.rows.filter(function (x) { return x.id === r.id; })[0] || r, ticked = false;
    if (!row.pt_at) { tapPick(row, "pt"); ticked = true; }
    try { await navigator.share({ files: files }); }
    catch (e) {
      btn.disabled = false;
      if (ticked && !pt.sent && row.pt_at) tapPick(row, "pt");
      // Cancel is a person changing their mind, not the phone refusing the set.
      if (BIG_SHARE && batch.length > PT_BATCH && e.name !== "AbortError") { BIG_SHARE = false; toast("Too many photos in one go for this phone. Sending 10 at a time instead.", true); return openPt(r); }
      if (e.name !== "AbortError") toast("Couldn't open sharing: " + e.message, true);
      return;
    }
    pt.sent = (pt.sent || 0) + batch.length;
    if (pt.sent < pt.items.length) { ptStore(); toast(pt.sent + " of " + pt.items.length + " sent. Now the next ones."); return openPt(r); }
    if (bkPending(pt)) ptStore(); else ptForget(pt.id);
    ptClear();
    toast(ptCaption(r) + ": all photos sent, PT done");
    $("panel").close();
  }

  // ── PT as one PDF ──
  // Every photo on its own page, full quality: the JPEGs go into the PDF as
  // they are (no re-compressing), so it's quick and sharp. Made in the
  // background as soon as the photos are ready, because Chrome only lets a
  // page share within a few seconds of the tap. Android takes 50 MB in one
  // share, so a very big set becomes parts (each one tap).
  var PDF_PART_MAX = 45 * 1048576;
  function ptWantsPdf() { return !!(S.company && S.company.pt_method === "pdf"); }
  function ptPdfState() {
    var n = pt.items.filter(function (x) { return x.state === "local"; }).length, P = pt.pdf;
    if (!P || P.count !== n) { ptPdfMake(pt); return { ready: false, label: "Making the PDF…" }; }
    if (P.error) return { failed: true };
    return { ready: true, label: P.parts.length === 1 ? "SEND AS ONE PDF (1 TAP)" : "SEND PDF PART " + ((P.sent || 0) + 1) + " OF " + P.parts.length };
  }
  async function ptPdfMake(cur) {
    var items = cur.items.filter(function (x) { return x.state === "local"; });
    if (cur.pdfMaking === items.length) return;
    cur.pdfMaking = items.length;
    var P = { count: items.length, parts: [], sent: cur.pdfSent || 0 };
    try {
      var jpgs = [];
      for (var i = 0; i < items.length; i++) jpgs.push(await ptJpegBytes(items[i].file));
      var group = [], size = 0;
      jpgs.forEach(function (j) { if (group.length && size + j.bytes.length > PDF_PART_MAX) { P.parts.push(group); group = []; size = 0; } group.push(j); size += j.bytes.length; });
      if (group.length) P.parts.push(group);
      var reg = (cur.reg || "car").replace(/\s+/g, "");
      P.parts = P.parts.map(function (g, k) {
        var name = reg + "-PT-" + items.length + "-photos" + (P.parts.length > 1 ? "-part" + (k + 1) : "") + ".pdf";
        return new File([ptPdfBlob(g, reg + " PT photos")], name, { type: "application/pdf" });
      });
      // A phone that can't hand a PDF to another app gets the photos way instead.
      if (!navigator.canShare || !navigator.canShare({ files: [P.parts[0]] })) P.error = true;
    } catch (e) { oopsLog(e); P.error = true; }
    if (pt !== cur || cur.pdfMaking !== items.length) return;
    cur.pdfMaking = 0; cur.pdf = P;
    if ($("panel").open && panelRow && panelRow.id === cur.id && !$("camVideo")) openPt(panelRow);
  }
  // The photo as JPEG bytes with its size (anything else is turned into a JPEG).
  async function ptJpegBytes(b) {
    var bytes = new Uint8Array(await b.arrayBuffer()), d = jpegSize(bytes);
    if (d) return { bytes: bytes, w: d.w, h: d.h, c: d.c };
    var im = await createImageBitmap(b), c = document.createElement("canvas"); c.width = im.width; c.height = im.height;
    c.getContext("2d").drawImage(im, 0, 0); if (im.close) im.close();
    var j = await new Promise(function (ok) { c.toBlob(ok, "image/jpeg", PT_Q); });
    bytes = new Uint8Array(await j.arrayBuffer()); d = jpegSize(bytes);
    return { bytes: bytes, w: d.w, h: d.h, c: d.c };
  }
  function jpegSize(b) {
    if (b[0] !== 0xFF || b[1] !== 0xD8) return null;
    for (var i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xFF) { i++; continue; }
      var m = b[i + 1];
      if (m === 0xFF) { i++; continue; }
      if (m === 0x01 || (m >= 0xD0 && m <= 0xD8)) { i += 2; continue; }
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8], c: b[i + 9] };
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
    return null;
  }
  // A plain PDF: one A4-wide page per photo, the photo filling the page.
  function ptPdfBlob(jpgs, title) {
    var enc = new TextEncoder(), parts = [], pos = 0, offs = [], kids = [];
    function add(x) { var b = typeof x === "string" ? enc.encode(x) : x; parts.push(b); pos += b.length; }
    function start(n) { offs[n] = pos; add(n + " 0 obj\n"); }
    add("%PDF-1.4\n");
    jpgs.forEach(function (j, i) {
      var page = 4 + i * 3, cont = page + 1, img = page + 2, W = 595, H = Math.round(595 * j.h / j.w);
      var cs = j.c === 1 ? "/DeviceGray" : j.c === 4 ? "/DeviceCMYK /Decode [1 0 1 0 1 0 1 0]" : "/DeviceRGB";
      start(page); add("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + W + " " + H + "] /Resources << /XObject << /Im0 " + img + " 0 R >> >> /Contents " + cont + " 0 R >>\nendobj\n");
      var body = "q " + W + " 0 0 " + H + " 0 0 cm /Im0 Do Q";
      start(cont); add("<< /Length " + body.length + " >>\nstream\n" + body + "\nendstream\nendobj\n");
      start(img); add("<< /Type /XObject /Subtype /Image /Width " + j.w + " /Height " + j.h + " /ColorSpace " + cs + " /BitsPerComponent 8 /Filter /DCTDecode /Length " + j.bytes.length + " >>\nstream\n");
      add(j.bytes); add("\nendstream\nendobj\n");
      kids.push(page + " 0 R");
    });
    start(1); add("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
    start(2); add("<< /Type /Pages /Kids [" + kids.join(" ") + "] /Count " + kids.length + " >>\nendobj\n");
    start(3); add("<< /Title (" + String(title).replace(/[()\\]/g, "") + ") /Producer (TakeOff) >>\nendobj\n");
    var size = 4 + jpgs.length * 3, xref = pos, x = "xref\n0 " + size + "\n0000000000 65535 f \n";
    for (var n = 1; n < size; n++) x += String(offs[n]).padStart(10, "0") + " 00000 n \n";
    add(x + "trailer\n<< /Size " + size + " /Root 1 0 R /Info 3 0 R >>\nstartxref\n" + xref + "\n%%EOF\n");
    return new Blob(parts, { type: "application/pdf" });
  }
  async function ptSharePdf(r, btn) {
    var P = pt && pt.pdf; if (!P || P.error || !P.parts.length) return;
    var file = P.parts[P.sent || 0]; if (!file) return;
    var data = { files: [file], text: ptCaption(r) + (P.parts.length > 1 ? " (" + ((P.sent || 0) + 1) + " of " + P.parts.length + ")" : "") };
    if (!navigator.canShare || !navigator.canShare({ files: [file] })) { P.error = true; toast("This phone can't pass a PDF to WhatsApp from the app. Send them as photos instead.", true); return openPt(r); }
    btn.disabled = true;
    var row = S.rows.filter(function (x) { return x.id === r.id; })[0] || r, ticked = false;
    if (!row.pt_at) { tapPick(row, "pt"); ticked = true; }
    try { await navigator.share(data); }
    catch (e) {
      btn.disabled = false;
      if (ticked && !P.sent && row.pt_at) tapPick(row, "pt");
      if (e.name !== "AbortError") toast("Couldn't open sharing: " + e.message, true);
      return;
    }
    P.sent = (P.sent || 0) + 1; pt.pdfSent = P.sent;
    if (P.sent < P.parts.length) { ptStore(); toast("Part " + P.sent + " of " + P.parts.length + " sent. Now the next part."); return openPt(r); }
    pt.sent = pt.items.length; pt.regSent = true;
    if (bkPending(pt)) ptStore(); else ptForget(pt.id);
    ptClear();
    toast(ptCaption(r) + ": PDF sent, PT done");
    $("panel").close();
  }

  // Kept on the phone (IndexedDB) until every photo is sent: Android often
  // reloads the app while WhatsApp is open, and they'd be gone otherwise.
  var ptDbP = null, PT_KEEP_MS = 12 * 3600000;
  function ptDb() {
    return ptDbP || (ptDbP = new Promise(function (ok, no) {
      var q = indexedDB.open("takeoff-pt", 1);
      q.onupgradeneeded = function () { q.result.createObjectStore("pt", { keyPath: "id" }); };
      q.onsuccess = function () { ok(q.result); }; q.onerror = function () { no(q.error); };
    }));
  }
  async function ptStore() {
    if (!pt || pt.mode !== "photos") return;
    // Taken now, before anything can clear pt.
    var keep = pt.items.filter(function (x) { return x.state === "local"; });
    var rec = { id: pt.id, reg: pt.reg, at: Date.now(), regSent: !!pt.regSent, sent: pt.sent || 0, pdfSent: pt.pdfSent || 0, token: pt.token,
      blobs: keep.map(function (x) { return x.file; }), thumbs: keep.map(function (x) { return x.url || ""; }), bk: keep.map(function (x) { return x.bk === "done"; }) };
    try { (await ptDb()).transaction("pt", "readwrite").objectStore("pt").put(rec); } catch (e) {}
  }
  async function ptForget(id) { try { (await ptDb()).transaction("pt", "readwrite").objectStore("pt").delete(id); } catch (e) {} }
  async function ptSaved() {
    try {
      var db = await ptDb();
      return await new Promise(function (ok) { var q = db.transaction("pt").objectStore("pt").getAll(); q.onsuccess = function () { ok(q.result || []); }; q.onerror = function () { ok([]); }; });
    } catch (e) { return []; }
  }
  function ptRestore(rec) {
    ptClear();
    pt = { id: rec.id, reg: rec.reg, mode: "photos", token: rec.token || ptToken(), items: [], saved: 0, sent: rec.sent || 0, pdfSent: rec.pdfSent || 0, regSent: !!rec.regSent };
    (rec.blobs || []).forEach(function (b, i) { pt.items.push({ file: b, url: (rec.thumbs || [])[i] || "", state: "local", n: i + 1, ready: true, bk: (rec.bk || [])[i] ? "done" : undefined }); });
    bkQueueSet(pt.id, pt.token, pt.items);
  }
  // All sent but the app's copy didn't finish uploading before a reload: finish it quietly.
  function bkRestore(rec) {
    var token = rec.token; if (!token) return ptForget(rec.id);
    var items = (rec.blobs || []).map(function (b, i) { return { file: b, n: i + 1, bk: (rec.bk || [])[i] ? "done" : undefined }; });
    // All up already, but maybe not saved as a set before the reload: save it (saving twice is harmless).
    if (items.every(function (x) { return x.bk === "done"; })) {
      items.forEach(function (x) { x.path = bkPath(rec.id, token, x.n); });
      sb.rpc("pt_link_save", { p_token: token, p_booking: rec.id, p_paths: items.map(function (x) { return x.path; }) }).then(function (res) { if (!res.error) ptForget(rec.id); });
      return;
    }
    bkQueueSet(rec.id, token, items);
  }
  // Tapping PT on a car: carry on where it left off, or straight into the camera.
  async function ptStart(r) {
    if (!pt || pt.id !== r.id) {
      var rec = (await ptSaved()).filter(function (x) { return x.id === r.id && Date.now() - x.at < PT_KEEP_MS; })[0];
      if (rec && S.company && S.company.pt_method !== "link") ptRestore(rec);
    }
    openPt(r);
    if (!pt.items.length && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) ptCamera(r);
  }
  // After a reload: open the PT that was half sent.
  async function ptResume() {
    var list = await ptSaved();
    list.forEach(function (x) { if (Date.now() - x.at >= PT_KEEP_MS) ptForget(x.id); });
    list = list.filter(function (x) { return Date.now() - x.at < PT_KEEP_MS && (x.blobs || []).length; });
    list.filter(function (x) { return x.sent >= x.blobs.length; }).forEach(bkRestore);
    var rec = list.filter(function (x) { return x.sent < x.blobs.length; })[0];
    var row = rec && S.rows.filter(function (x) { return x.id === rec.id; })[0];
    if (!row || pt || $("panel").open) return;
    ptRestore(rec); openPt(row);
    toast("Carrying on PT for " + ptCaption(row) + (rec.sent ? ": " + rec.sent + " of " + rec.blobs.length + " sent" : ""));
  }
  function tapPick(r, key, value) {
    var v = key === "intake" ? (r.intake === value ? "" : value) : key === "pt" ? (r.pt_at ? "" : "Done") : (r.pick_called === value ? "" : value);
    run("tap_pick", { p_booking: r.id, p_key: key, p_value: v }, r, function (x) {
      if (key === "intake") { x.intake = v; x.intake_at = v ? nowIso() : null; x.intake_by = v ? S.me.id : null; }
      else if (key === "pt") { x.pt_at = v ? nowIso() : null; x.pt_by = v ? S.me.id : null; }
      else { x.pick_called = v; x.pick_called_at = v ? nowIso() : null; }
    });
  }

  // ── car panel ─────────────────────────────
  var panelRow = null;
  // Booking files give UK mobiles as 447…, 7… or 07…; without the + or the 0
  // the phone can't dial them. Anything else is dialled as written.
  // Some bookings carry the number twice ("7868615571 7868615571") or two
  // numbers: take the first whole number (UK numbers are written in pieces,
  // "07868 615571", so pieces are joined until there are 10 digits).
  function firstPhone(p) {
    var acc = "";
    String(p || "").split(/[^\d+]+/).filter(Boolean).some(function (g) { acc += g; return acc.replace(/\D/g, "").length >= 10; });
    return acc;
  }
  function dialable(p) {
    var d = firstPhone(p).replace(/[^\d+]/g, "");
    if (/^44\d{10}$/.test(d)) return "+" + d;
    if (/^7\d{9}$/.test(d)) return "0" + d;
    return d;
  }
  function phoneLabel(p) {
    var d = dialable(p);
    if (/^\+447\d{9}$/.test(d)) return "+44 " + d.slice(3, 7) + " " + d.slice(7);
    if (/^07\d{9}$/.test(d)) return d.slice(0, 5) + " " + d.slice(5);
    return firstPhone(p) || String(p);
  }
  // ── early returns (database part 29) ──
  // Booked back on a later day but coming back tonight: the car moves onto the
  // sheet for the shift running now, marked EARLY. Undo puts it back.
  function canEarly(r) {
    if (r.kind !== "drops" || r.early || r.cleared_at || !can("called")) return false;
    var here = S.sheets.filter(function (x) { return x.id === r.sheet_id; })[0];
    return !!here && here.day > currentShiftKey();
  }
  function earlyHtml(r) {
    if (!can("called") || r.cleared_at) return "";
    var today = currentShiftKey();
    if (r.early) {
      var from = S.sheets.filter(function (x) { return x.id === r.moved_from; })[0];
      return '<button type="button" class="link" data-undoearly>Undo early return' + (from ? " (back to " + esc(sheetLabel(from)) + ")" : "") + "</button>";
    }
    if (!canEarly(r)) return "";
    return '<button type="button" class="btn ghost ptgo" data-early>EARLY RETURN · move to ' + esc(sheetLabel({ kind: "drops", day: today })) + "</button>";
  }
  async function earlyMove(r, btn, undo, asked) {
    if (!undo && !asked && !confirm("Move " + (r.reg || "this car") + " to tonight's sheet as an early return?")) return;
    btn.disabled = true;
    var x = await sb.rpc(undo ? "undo_early_return" : "early_return", { p_booking: r.id });
    btn.disabled = false;
    if (x.error) return toast(x.error.message, true);
    $("panel").close();
    // Follow the car to the sheet it's on now.
    S.sheetId = x.data.sheet_id; S.q = ""; S.yardFilter = "";
    await loadSheets(); await loadRows(); flashId = x.data.id; render();
    toast((r.reg || "Car") + (undo ? " is back on its booked day." : " moved to tonight's sheet as an early return."));
  }
  function openPanel(r) {
    panelRow = r;
    var drops = r.kind === "drops";
    function by(at, who) { return at ? esc(hhmm(at)) + (who ? " · " + esc(staffName(who)) : "") : "—"; }
    var det = [["NAME", esc(r.name) || "—"], ["CAR", /^[-\s.]*$/.test(r.make || "") ? "—" : esc(r.make)], ["REF", esc(r.ref) || "—"]];
    if (drops) {
      det.push(["MEET", r.drop_at ? esc(dayShort(r.drop_at) + " " + hhmm(r.drop_at)) : "—"]);
      det.push(["BACK", esc(dayShort(r.return_at) + " " + hhmm(r.return_at)) + (r.orig_return_at ? ' <span class="hint">· was ' + esc(dayShort(r.orig_return_at) + " " + hhmm(r.orig_return_at)) + "</span>" : "")]);
      det.push(["FLIGHT", esc(r.flight || "—") + (r.sched_time ? " · sched " + esc(r.sched_time) : "")]);
      if (r.est_time || r.flight_note) det.push(["ARRIVAL", (r.est_time ? "<b>" + esc(r.est_time) + "</b> " : "") + '<span class="hint">' + esc(r.flight_note) + "</span>"]);
      det.push(["SENT", by(r.sent_at, r.sent_by)], [r.called_word === "Overstay" ? "OVERSTAY" : "CALLED", by(r.called_at, r.called_by)], [r.clear_word === "COMPLAINT" ? "COMPLAINT" : "CLEAR", by(r.cleared_at, r.cleared_by)]);
    } else {
      det.push(["DROP-OFF", esc(dayShort(r.drop_at) + " " + hhmm(r.drop_at))], ["BACK", esc(dayShort(r.return_at) + " " + hhmm(r.return_at))]);
      if (r.intake) det.push([esc(r.intake.toUpperCase()), by(r.intake_at, r.intake_by)]);
    }
    var h = '<h2 id="panelTitle">' + esc(r.reg || "NO REG") + (r.num ? " <small>#" + r.num + "</small>" : "") + "</h2>" +
      '<p class="sub">' + esc(sheetLabel(sheet() || { day: "", kind: r.kind })) + "</p>" +
      (r.phone ? '<a class="tel" href="tel:' + esc(dialable(r.phone)) + '">Call ' + esc(phoneLabel(r.phone)) + "</a>" : "") +
      '<div class="det">' + det.map(function (x) { return "<div><b>" + x[0] + "</b><span>" + x[1] + "</span></div>"; }).join("") + "</div>";
    // A booking can come with no reg: the office can type or correct it, a
    // driver can fill in a missing one when the car comes in.
    var canReg = can("import") || (can("intake") && !r.reg);
    if (canReg) h += '<label for="regText">REG</label><input id="regText" value="' + esc(r.reg) + '" autocomplete="off" autocapitalize="characters" maxlength="12" placeholder="Type the reg">';
    if (drops && can("yard")) {
      h += '<label>YARD</label><div class="pseg yard">' + (S.company.yards || []).map(function (y) {
        return '<button type="button" data-setyard="' + esc(y) + '" class="' + (r.yard === y ? "on y-" + esc(y) : "") + '">' + esc(YARD_LABEL[y] || y) + "</button>";
      }).join("") + "</div>";
    }
    if (drops && can("flights")) {
      h += '<label for="flightText">FLIGHT NUMBER</label><input id="flightText" value="' + esc(r.flight) + '" autocomplete="off" autocapitalize="characters" maxlength="12" placeholder="or NO FLIGHT">';
      if (r.flight === "NO FLIGHT") h += '<label for="collectText">COLLECTION TIME</label>' + timeBox("collectText", /^\d{2}:\d{2}$/.test(r.est_time) ? r.est_time : "");
      else h += '<label for="schedText">SCHEDULED LANDING</label>' + timeBox("schedText", /^\d{2}:\d{2}$/.test(r.sched_time) ? r.sched_time : "");
    }
    if (can("note")) h += '<label for="noteText">NOTE</label><textarea id="noteText" maxlength="500">' + esc(r.note) + '</textarea>';
    var extra = "";
    if (drops) {
      if (can("called")) extra += '<button type="button" data-word="called:Overstay" class="' + (r.called_word === "Overstay" ? "on nb" : "") + '">OVERSTAY</button>';
      if (can("clear")) extra += '<button type="button" data-word="clear:COMPLAINT" class="' + (r.clear_word === "COMPLAINT" ? "on cm" : "") + '">COMPLAINT</button>';
    } else if (can("intake")) {
      extra += '<button type="button" data-pcall="Called" class="' + (r.pick_called === "Called" ? "on" : "") + '">CALLED</button>';
      extra += '<button type="button" data-pcall="New Booking" class="' + (r.pick_called === "New Booking" ? "on nb" : "") + '">NEW BOOKING</button>';
    }
    if (extra) h += '<label>MARK AS</label><div class="pseg">' + extra + "</div>";
    if (drops) h += chargePanelHtml(r);
    if (drops) h += earlyHtml(r);
    // PT photos from when the car came in (PICKS), also on its DROPS row: same booking ref.
    h += '<div id="ptPhotos"></div>';
    if (can("import")) h += '<button type="button" class="link rmcar" data-removecar>Remove this car (no show, cancelled)</button>';
    h += '<div class="pbtns"><button type="button" data-close>Close</button>' + (can("note") || can("flights") || canReg ? '<button type="button" class="save" data-savepanel>Save</button>' : "") + "</div>";
    $("panelBody").innerHTML = h;
    if (!$("panel").open) $("panel").showModal();
    ptPhotosList(r);
  }
  // The car's PT photos (kept 3 days). View opens the same page PT gets.
  async function ptPhotosList(r) {
    var res = await sb.rpc("pt_photos_for", { p_booking: r.id });
    var el = $("ptPhotos"); if (!el || panelRow !== r || res.error) return;
    var sets = res.data || [];
    if (!sets.length) { if (r.pt_at && r.kind === "picks") el.innerHTML = '<label>PT PHOTOS</label><p class="hint">No copy of the photos in the app for this car.</p>'; return; }
    el.innerHTML = "<label>PT PHOTOS</label>" + sets.map(function (x) {
      return '<a class="ptset" href="/p/' + esc(x.token) + '" target="_blank" rel="noopener"><span><b>' + x.n + " photo" + (x.n === 1 ? "" : "s") + "</b> · " + esc(dayShort(x.at) + " " + hhmm(x.at)) + (x.by ? " · " + esc(x.by) : "") + "</span><i>View ›</i></a>";
    }).join("");
  }
  $("panel").addEventListener("close", function () { camStop(); panelRow = null; quick = null; staffEdit = null; render(); setTimeout(bkPump, 500); });
  // Closes on a tap outside only when the press started outside too: selecting
  // text in a box and letting go past the edge must not close it.
  var downOn = {};
  ["panel", "menu"].forEach(function (id) { $(id).addEventListener("pointerdown", function (e) { downOn[id] = e.target; }); });
  function outside(id, e) { var hit = e.target === $(id) && downOn[id] === $(id); downOn[id] = null; return hit; }
  $("panel").addEventListener("click", function (e) {
    if (outside("panel", e)) return $("panel").close();          // tap outside the sheet
    if (e.target === $("panel")) return;
    var t = e.target.closest("button"); if (!t) return;
    if (t.dataset.close !== undefined) return $("panel").close();
    if (t.dataset.pickflight && quick) return saveQuickFlight(t.dataset.pickflight, undefined, t.dataset.picksched);
    if (t.dataset.noflight !== undefined && quick) { quick.noFlight = true; drawQuickFlight(); setTimeout(function () { var i = $("collectTime"); if (i) i.focus(); }, 50); return; }
    if (t.dataset.flightback !== undefined && quick) { quick.noFlight = false; drawQuickFlight(); return; }
    if (t.dataset.copy === "returns" || t.dataset.copy === "stats") { e.stopPropagation(); return putOnClipboard(copyText(t.dataset.copy)); }
    if (t.dataset.restore) return restoreCar(t);
    if (t.dataset.gone) return removeGone([t.dataset.gone], t);
    if (t.dataset.goneall !== undefined) return removeGone(Array.prototype.map.call($("panelBody").querySelectorAll("[data-gone]"), function (b) { return b.dataset.gone; }), t);
    if (staffEdit && (t.dataset.saveaccess !== undefined || t.dataset.roledefault !== undefined || t.dataset.savepin !== undefined || t.dataset.removestaff !== undefined)) return staffPanelAction(t);
    if (!panelRow) return;
    var r = S.rows.filter(function (x) { return x.id === panelRow.id; })[0] || panelRow;
    if (t.dataset.savepanel !== undefined) {
      var saved = false;
      if ($("regText")) {
        var g = $("regText").value.trim().toUpperCase().replace(/\s+/g, " ");
        if (g !== r.reg) {
          if (!/^[A-Z0-9 ]{0,12}$/.test(g)) return toast("Check the reg: letters and numbers only.", true);
          run("set_reg", { p_booking: r.id, p_reg: g }, r, function (x) { x.reg = g; }); saved = true;
        }
      }
      // The note first: turning a car into NO FLIGHT moves on to the
      // collection-time screen, and a note typed alongside must not be lost.
      if ($("noteText")) {
        var text = $("noteText").value.trim();
        if (text !== r.note) { run("set_note", { p_booking: r.id, p_note: text }, r, function (x) { x.note = text; }); saved = true; }
      }
      if ($("flightText")) {
        var f = normFlight($("flightText").value), ct = readTime("collectText"), st = readTime("schedText");
        if (ct === null || st === null) return toast("Type the time like 13:20 (or 1320).", true);
        if (f === "NO FLIGHT" && r.flight !== "NO FLIGHT") { panelRow = null; quick = { id: r.id, chain: false, suggest: [], noFlight: true }; drawQuickFlight(); return; }
        // The old flight's time left in the box doesn't carry over to a new flight number.
        if (f !== r.flight && st === (r.sched_time || "")) st = undefined;
        if (f !== r.flight || (f === "NO FLIGHT" && ct !== undefined && ct !== (r.est_time || "")) || (st !== undefined && st !== (r.sched_time || ""))) { setFlight(r, f, ct, st); saved = true; }
      }
      if (saved) toast("Saved");
      return $("panel").close();
    }
    if (t.dataset.setyard) {
      var y = r.yard === t.dataset.setyard ? "" : t.dataset.setyard;
      run("set_yard", { p_booking: r.id, p_yard: y }, r, function (x) { x.yard = y; x.yard_before_t = ""; });
      return openPanel(r);
    }
    if (t.dataset.word) { var p = t.dataset.word.split(":"); tapDrop(r, p[0], p[1]); return $("panel").close(); }
    if (t.dataset.pcall) { tapPick(r, "called", t.dataset.pcall); return $("panel").close(); }
    if (t.dataset.ptcam !== undefined) return ptCamera(r);
    if (t.dataset.shutter !== undefined) return ptShoot(r);
    if (t.dataset.camtorch !== undefined) return camToggleTorch();
    if (t.dataset.camdone !== undefined) { camStop(); openPt(r); ptStore(); return ptPump(r); }
    if (t.dataset.ptretry !== undefined) return ptRetry(r);
    if (t.dataset.ptlinkshare !== undefined) {
      // No PT number in Settings: share the message and pick the chat.
      if (!navigator.share) return toast("Set the PT WhatsApp number in Settings.", true);
      navigator.share({ text: ptMessage(r) }).then(function () { ptSent(r); }).catch(function () {});
      return;
    }
    if (t.dataset.ptclear !== undefined) {
      if (pt) { var tk = pt.token; BK = BK.filter(function (y) { return y.token !== tk; }); ptForget(pt.id); }
      ptClear(); return openPt(r);
    }
    if (t.dataset.ptshare !== undefined) return ptShare(r, t);
    if (t.dataset.ptpdf !== undefined) return ptSharePdf(r, t);
    if (t.dataset.ptregshare !== undefined) {
      // No PT number in Settings: share the reg and pick the chat.
      if (!navigator.share) return toast("Set the PT WhatsApp number in Settings.", true);
      navigator.share({ text: ptCaption(r) }).then(function () { if (pt) { pt.regSent = true; ptStore(); } openPt(r); }).catch(function () {});
      return;
    }
    if (t.dataset.ptmark !== undefined) { if (!r.pt_at) tapPick(r, "pt"); if (pt) ptForget(pt.id); ptClear(); return $("panel").close(); }
    if (t.dataset.charge) { recordCharge(r, t.dataset.charge); return openPanel(r); }
    if (t.dataset.chargeundo !== undefined) { recordCharge(r, ""); return openPanel(r); }
    if (t.dataset.removecar !== undefined) return askRemove(r);
    if (t.dataset.early !== undefined) return earlyMove(r, t, false);
    if (t.dataset.undoearly !== undefined) return earlyMove(r, t, true);
    if (t.dataset.backcar !== undefined) return openPanel(r);
    if (t.dataset.removewhy) return removeCar(r, t.dataset.removewhy, t);
  });

  // ── add a car by hand, remove a no-show (office) ──
  function askRemove(r) {
    $("panelBody").innerHTML = '<h2 id="panelTitle">Remove ' + esc(r.reg || "this car") + "?</h2>" +
      '<p class="sub">It leaves the board and the counts, and is never carried over as an overstay. You can put it back from Menu, Removed cars.</p>' +
      '<label>WHY</label><div class="pseg">' + ["No show", "Cancelled", "Duplicate"].map(function (w) {
        return '<button type="button" data-removewhy="' + w + '">' + w.toUpperCase() + "</button>";
      }).join("") + '</div><div class="pbtns"><button type="button" data-backcar>Back</button></div>';
  }
  async function removeCar(r, why, btn) {
    btn.disabled = true;
    var x = await sb.rpc("remove_booking", { p_booking: r.id, p_reason: why });
    if (x.error) { btn.disabled = false; return toast(x.error.message, true); }
    S.rows = S.rows.filter(function (y) { return y.id !== r.id; });
    dropRemoved(r.id); S.removed.push(x.data);
    toast(r.reg + " removed: " + why);
    $("panel").close();
  }
  function openRemoved() {
    var list = (S.removed || []).slice().sort(function (a, b) { return a.removed_at < b.removed_at ? 1 : -1; });
    $("panelBody").innerHTML = '<h2 id="panelTitle">Removed cars <small>' + esc(sheetName()) + "</small></h2>" +
      (list.length ? '<div class="rmlist">' + list.map(function (r) {
        return '<div><span><b>' + esc(r.reg || "NO REG") + "</b> " + esc(r.name) + '<small>' + esc(r.removed_reason) + " · " + esc(staffName(r.removed_by) || "") + " · " + esc(dayShort(r.removed_at) + " " + hhmm(r.removed_at)) +
          '</small></span><button type="button" data-restore="' + r.id + '">Put back</button></div>';
      }).join("") + "</div>" : '<p class="sub">Nothing removed from this sheet.</p>') +
      '<div class="pbtns"><button type="button" data-close>Close</button></div>';
    if (!$("panel").open) $("panel").showModal();
  }
  async function restoreCar(btn) {
    btn.disabled = true;
    var x = await sb.rpc("restore_booking", { p_booking: btn.dataset.restore });
    if (x.error) { btn.disabled = false; return toast(x.error.message, true); }
    // The live update may have put it back already: replace, never add twice.
    dropRemoved(x.data.id);
    var at = S.rows.findIndex(function (y) { return y.id === x.data.id; });
    if (at >= 0) S.rows[at] = x.data; else S.rows.push(x.data);
    toast(x.data.reg + " is back on the board");
    openRemoved();
  }
  function openAddCar() {
    var sh = sheet(); if (!sh) return;
    var drops = sh.kind === "drops";
    function f(id, label, attrs) { return '<label for="' + id + '">' + label + '</label><input id="' + id + '" ' + (attrs || "") + ">"; }
    function when(id, label, day) { return '<label>' + label + '</label><div class="when2"><input id="' + id + 'D" type="date" value="' + esc(day || "") + '">' + timeBox(id + "T", "") + "</div>"; }
    $("panelBody").innerHTML = '<h2 id="panelTitle">Add a car <small>' + esc(sheetLabel(sh)) + "</small></h2>" +
      '<form id="addCarForm" novalidate>' +
      f("acReg", "REG", 'autocomplete="off" autocapitalize="characters" maxlength="12" required') +
      f("acName", "NAME", 'autocomplete="off" maxlength="80"') +
      f("acPhone", "PHONE", 'type="tel" autocomplete="off" maxlength="30"') +
      f("acMake", "CAR", 'autocomplete="off" maxlength="60" placeholder="Make and colour"') +
      f("acRef", "REF", 'autocomplete="off" maxlength="40" placeholder="Booking reference, if there is one"') +
      (drops ? when("acRet", "BACK", sh.day) + f("acFlight", "FLIGHT", 'autocomplete="off" autocapitalize="characters" maxlength="12"') +
        '<label for="acYard">YARD</label><select id="acYard"><option value="">None yet</option>' + (S.company.yards || []).map(function (y) { return '<option value="' + esc(y) + '">' + esc(YARD_LABEL[y] || y) + "</option>"; }).join("") + "</select>"
        : when("acDrop", "DROP-OFF", sh.day) + when("acRet", "BACK", "")) +
      '<label for="acNote">NOTE</label><textarea id="acNote" maxlength="500"></textarea>' +
      '<div class="pbtns"><button type="button" data-close>Cancel</button><button class="save" id="acGo">Add car</button></div></form>';
    if (!$("panel").open) $("panel").showModal();
    setTimeout(function () { $("acReg").focus(); }, 50);
  }
  // "" when no date; null when the typed time isn't one.
  function localWhen(id) {
    var d = $(id + "D"), t = readTime(id + "T");
    if (!d || !d.value) return "";
    if (t === null) return null;
    return d.value + " " + (t || "00:00");
  }
  async function addCar() {
    var sh = sheet(), reg = $("acReg").value.trim();
    if (!reg) return toast("Enter the registration.", true);
    var ret = localWhen("acRet"), drop = sh.kind === "picks" ? localWhen("acDrop") : "";
    if (ret === null || drop === null) return toast("Type the time like 13:20 (or 1320).", true);
    if (sh.kind === "drops") {
      if (!ret || !readTime("acRetT")) return toast("Enter when the car is back: the date and the time.", true);
      // The DROPS day runs to 06:00 next morning: 01:30 typed on the sheet's own
      // date means the early hours after it, not the morning before.
      var end = ((S.company && S.company.drops_day_end) || "06:00").slice(0, 5);
      if (ret.slice(0, 10) === sh.day && ret.slice(11) <= end) ret = addDaysKey(sh.day, 1) + ret.slice(10);
    }
    var p = { reg: reg, name: $("acName").value, phone: $("acPhone").value, make: $("acMake").value, ref: $("acRef").value, note: $("acNote").value,
      return_local: ret, drop_local: drop,
      flight: $("acFlight") ? normFlight($("acFlight").value) || "" : "", yard: $("acYard") ? $("acYard").value : "" };
    $("acGo").disabled = true;
    var x = await sb.rpc("add_booking", { p_sheet: sh.id, p: p });
    if (x.error) { $("acGo").disabled = false; return toast(x.error.message, true); }
    await loadRows();
    toast(x.data.reg + " added");
    $("panel").close();
  }

  // ── PICKS: returns by day, stats by hour (as on the Sheet app) ──
  function ordinal(d) { var t = d % 10, h = d % 100; return t === 1 && h !== 11 ? "ST" : t === 2 && h !== 12 ? "ND" : t === 3 && h !== 13 ? "RD" : "TH"; }
  function carsWord(n) { return n + (n === 1 ? " CAR" : " CARS"); }
  function moneyIn(note) { var m = String(note || "").match(/£\s*(\d+(?:\.\d{2})?)/g); return m ? m.reduce(function (t, x) { return t + (parseFloat(x.replace(/[^\d.]/g, "")) || 0); }, 0) : 0; }
  // "cash" or "card" in the note; both words (or neither) stays unmarked.
  function payKind(note) { var t = String(note || ""), cash = /\bcash\b/i.test(t), card = /\bcard\b/i.test(t); return cash && !card ? "cash" : card && !cash ? "card" : ""; }
  function sheetName() { var sh = sheet(); return sh ? sheetLabel(sh) : ""; }

  function picksReturns() {
    var groups = {}, owed = [];
    S.rows.forEach(function (r) {
      var k = r.return_at ? londonParts(new Date(r.return_at)).key : "";
      if (!groups[k]) { var d = k ? +k.slice(8, 10) : 0; groups[k] = { key: k || "9999", label: k ? pad(d) + ordinal(d) : "NO RETURN DATE", n: 0 }; }
      groups[k].n++;
      if (moneyIn(r.note)) owed.push({ line: (r.reg || "(no reg)") + " · " + (r.name || ""), due: moneyIn(r.note), note: r.note.replace(/^!\s*/, ""), kind: payKind(r.note) });
    });
    return { days: Object.keys(groups).map(function (k) { return groups[k]; }).sort(function (a, b) { return a.key < b.key ? -1 : 1; }), owed: owed, cars: S.rows.length };
  }
  function picksStats() {
    var sched = {}, done = {}, last30 = 0, last60 = 0, now = Date.now();
    S.rows.forEach(function (r) {
      // Both columns by the BOOKED hour: "of the cars due this hour, how many are in".
      var isIn = r.intake === "Collected" || r.intake === "RTC";
      if (r.drop_at) { var h = +londonParts(new Date(r.drop_at)).time.slice(0, 2); sched[h] = (sched[h] || 0) + 1; if (isIn) done[h] = (done[h] || 0) + 1; }
      // The rolling counts are cars actually taken in lately; RTC has already gone again.
      if (r.intake === "Collected" && r.intake_at) { var m = (now - new Date(r.intake_at).getTime()) / 60000; if (m >= 0 && m <= 30) last30++; if (m >= 0 && m <= 60) last60++; }
    });
    var hours = [], ts = 0, td = 0;
    for (var h = 0; h < 24; h++) {
      if (!sched[h] && !done[h]) continue;
      ts += sched[h] || 0; td += done[h] || 0;
      hours.push({ label: pad(h) + ":00–" + pad((h + 1) % 24) + ":00", sched: sched[h] || 0, done: done[h] || 0 });
    }
    return { hours: hours, totalSched: ts, totalDone: td, last30: last30, last60: last60 };
  }
  // DROPS by the booked return hour, in shift order (06:00 round to 05:59).
  // Overstays are older returns, so they get their own line, not an hour.
  function dropsStats() {
    var due = {}, sent = {}, done = {}, over = { due: 0, sent: 0, done: 0 }, last30 = 0, last60 = 0, now = Date.now();
    // Morning shift 06:00–18:00, night shift 18:01–05:59, by the booked return time.
    var morning = { due: 0, sent: 0, done: 0 }, night = { due: 0, sent: 0, done: 0 };
    var shift = (sheet() || {}).day, start = +((S.company && S.company.drops_day_end) || "06").slice(0, 2);
    S.rows.forEach(function (r) {
      var isSent = !!r.sent_at, isDone = !!r.cleared_at;
      var p = r.return_at ? londonParts(new Date(r.return_at)) : null;
      var old = r.overstay || !p || (p.key < shift) || (p.key === shift && +p.time.slice(0, 2) < start);
      if (old) { over.due++; if (isSent) over.sent++; if (isDone) over.done++; }
      else {
        // Hours since the shift began: 06:00 on the next morning is the shift's last slot, not its first.
        var later = Math.round((Date.parse(p.key) - Date.parse(shift)) / 86400000);
        var h = later * 24 + +p.time.slice(0, 2) - start;
        due[h] = (due[h] || 0) + 1; if (isSent) sent[h] = (sent[h] || 0) + 1; if (isDone) done[h] = (done[h] || 0) + 1;
        var mins = +p.time.slice(0, 2) * 60 + +p.time.slice(3, 5), sh2 = mins >= 360 && mins <= 1080 ? morning : night;
        sh2.due++; if (isSent) sh2.sent++; if (isDone) sh2.done++;
      }
      if (r.cleared_at) { var m = (now - new Date(r.cleared_at).getTime()) / 60000; if (m >= 0 && m <= 30) last30++; if (m >= 0 && m <= 60) last60++; }
    });
    var hours = [], t = { due: over.due, sent: over.sent, done: over.done };
    Object.keys(due).map(Number).sort(function (a, b) { return a - b; }).forEach(function (i) {
      var h = (start + i) % 24, nextDay = i >= 24 ? " (" + dayWord(addDaysKey(shift, Math.floor((start + i) / 24))) + ")" : "";
      t.due += due[i]; t.sent += sent[i] || 0; t.done += done[i] || 0;
      hours.push({ label: pad(h) + ":00–" + pad((h + 1) % 24) + ":00" + nextDay, due: due[i], sent: sent[i] || 0, done: done[i] || 0 });
    });
    return { hours: hours, over: over, total: t, morning: morning, night: night, last30: last30, last60: last60 };
  }
  function chargeTotals() {
    var t = { due: 0, dueCars: 0, cash: 0, card: 0, waived: 0 };
    S.rows.forEach(function (r) {
      if (r.charge_method) { t[r.charge_method] = (t[r.charge_method] || 0) + (+r.charge_amount || 0); return; }
      var d = overstayDue(r); if (d) { t.due += d.amount; t.dueCars++; }
    });
    return t;
  }
  function chargeLines() {
    if (!(+(S.company && S.company.overstay_rate))) return [];
    var t = chargeTotals();
    return [["Overstay: still owed (" + t.dueCars + ")", money(t.due)], ["Overstay paid: cash", money(t.cash)], ["Overstay paid: card", money(t.card)], ["Overstay waived", money(t.waived)]];
  }
  function openDropsStats() {
    var D = dropsStats();
    function line(label, x, cls) { return '<div class="pst4' + (cls || "") + '"><b' + (cls ? "" : ' class="num"') + ">" + label + '</b><i class="num">' + x.due + '</i><i class="num">' + x.sent + '</i><i class="num' + (x.done ? " dn" : "") + '">' + x.done + "</i></div>"; }
    $("panelBody").innerHTML = '<h2 id="panelTitle">DROPS by hour <small>' + esc(sheetName()) + "</small></h2>" +
      '<div class="pst4 head"><b>Due back</b><i>Due</i><i>Sent</i><i>Collected</i></div>' +
      D.hours.map(function (h) { return line(h.label, h); }).join("") +
      (D.over.due ? line("Overstays", D.over, " sec2") : "") +
      line("TOTAL", D.total, " tot") +
      line("Morning 06:00–18:00", D.morning, " shift") + line("Night 18:01–05:59", D.night, " shift") +
      (D.over.due ? '<div class="hint">Overstays are counted on their own, not in a shift.</div>' : "") +
      '<div class="pst4"><b>Collected, last 30 min</b><i class="num">' + D.last30 + '</i><i></i><i></i></div><div class="pst4"><b>Collected, last 60 min</b><i class="num">' + D.last60 + "</i><i></i><i></i></div>" +
      chargeLines().map(function (x, i) { return '<div class="pst4' + (i === 0 ? " owed" : "") + '"><b>' + esc(x[0]) + '</b><i></i><i></i><i class="num">' + x[1] + "</i></div>"; }).join("") +
      '<div class="pbtns"><button type="button" data-close>Close</button><button type="button" class="save" data-copy="stats">Copy</button></div>';
    panelRow = null; if (!$("panel").open) $("panel").showModal();
  }
  function catLines() {
    var sh = sheet(), n = catCounts();
    return CATS.filter(function (c) { return sh && (sh.short_until || c[0] === "same" || c[0] === "next"); })
      .map(function (c) { return [c[1] + (c[0] === "short" ? " (to " + dayWord(sh.short_until) + ")" : ""), n[c[0]]]; });
  }
  function catPanelHtml() {
    var lines = catLines();
    return "<label>CATEGORIES</label>" + '<div class="sumlist">' + lines.map(function (x) { return '<div class="sumrow"><b>' + esc(x[0]) + "</b><span>" + carsWord(x[1]) + "</span></div>"; }).join("") + "</div>" +
      (sheet() && !sheet().short_until ? '<div class="hint">Short dates not set.</div>' : "");
  }
  function openReturns() {
    var R0 = picksReturns();
    $("panelBody").innerHTML = '<h2 id="panelTitle">Returns <small>' + esc(sheetName()) + "</small></h2>" +
      "<label>BY DAY (" + R0.days.length + ")</label>" +
      (R0.days.length ? '<div class="sumlist">' + R0.days.map(function (d) { return '<div class="sumrow"><b>' + esc(d.label) + " RTNS</b><span>" + carsWord(d.n) + "</span></div>"; }).join("") + "</div>" : '<div class="hint">No cars on this sheet.</div>') +
      '<div class="hint">' + carsWord(R0.cars) + " on the sheet.</div>" + catPanelHtml() +
      "<label>MONEY NOTED (" + R0.owed.length + ")</label>" +
      (R0.owed.length ? '<div class="sumlist">' + R0.owed.map(function (x) {
        return '<div class="sumrow"><b>' + esc(x.line) + "</b><span>" + (x.kind ? '<b class="pay ' + x.kind + '">' + x.kind.toUpperCase() + "</b> " : "") + esc(x.note) + "</span></div>";
      }).join("") + "</div>" : '<div class="hint">None noted.</div>') +
      '<div class="pbtns"><button type="button" data-close>Close</button><button type="button" class="save" data-copy="returns">Copy</button></div>';
    panelRow = null; if (!$("panel").open) $("panel").showModal();
  }
  function openPicksStats() {
    var P = picksStats();
    $("panelBody").innerHTML = '<h2 id="panelTitle">PICKS stats <small>' + esc(sheetName()) + "</small></h2>" +
      '<div class="pst head"><b>Hour</b><i>Scheduled</i><i>Completed</i></div>' +
      P.hours.map(function (h) { return '<div class="pst"><b class="num">' + h.label + '</b><i class="num">' + h.sched + '</i><i class="num' + (h.done ? " dn" : "") + '">' + h.done + "</i></div>"; }).join("") +
      '<div class="pst tot"><b>TOTAL</b><i class="num">' + P.totalSched + '</i><i class="num dn">' + P.totalDone + "</i></div>" +
      '<div class="pst sec"><b>PICKS STATS</b></div>' +
      '<div class="pst"><b>Last 30 min</b><i class="num">' + P.last30 + '</i><i></i></div><div class="pst"><b>Last 60 min</b><i class="num">' + P.last60 + "</i><i></i></div>" +
      catLines().map(function (x) { return '<div class="pst"><b>' + x[0] + '</b><i class="num">' + x[1] + "</i><i></i></div>"; }).join("") +
      '<div class="pbtns"><button type="button" data-close>Close</button><button type="button" class="save" data-copy="stats">Copy</button></div>';
    panelRow = null; if (!$("panel").open) $("panel").showModal();
  }
  function copyText(kind) {
    var lines;
    if (kind === "returns") {
      var R0 = picksReturns();
      lines = ["RETURNS — " + sheetName(), ""].concat(R0.days.map(function (d) { return d.label + " RTNS " + carsWord(d.n); }), ["", carsWord(R0.cars) + " on the sheet", ""],
        catLines().map(function (x) { return x[0] + " " + carsWord(x[1]); }));
      if (R0.owed.length) {
        lines.push("", "MONEY NOTED (" + R0.owed.length + ")");
        R0.owed.forEach(function (x) { lines.push("  " + x.line + " - " + (x.kind ? x.kind.toUpperCase() + " - " : "") + x.note); });
        lines.push("TOTAL £" + R0.owed.reduce(function (t, x) { return t + x.due; }, 0).toFixed(2));
      }
    } else if ((sheet() || {}).kind === "drops") {
      var D = dropsStats();
      lines = ["DROPS BY HOUR — " + sheetName(), "", "Due back   Due   Sent   Collected"].concat(D.hours.map(function (h) { return h.label + "   " + h.due + "   " + h.sent + "   " + h.done; }),
        D.over.due ? ["Overstays   " + D.over.due + "   " + D.over.sent + "   " + D.over.done] : [],
        ["TOTAL   " + D.total.due + "   " + D.total.sent + "   " + D.total.done, "",
          "Morning 06:00–18:00   " + D.morning.due + "   " + D.morning.sent + "   " + D.morning.done,
          "Night 18:01–05:59   " + D.night.due + "   " + D.night.sent + "   " + D.night.done, "", "Collected last 30 min   " + D.last30, "Collected last 60 min   " + D.last60],
        chargeLines().length ? [""].concat(chargeLines().map(function (x) { return x[0] + "   " + x[1]; })) : []);
    } else {
      var P = picksStats();
      lines = ["PICKS STATS — " + sheetName(), "", "Hour   Scheduled   Completed"].concat(P.hours.map(function (h) { return h.label + "   " + h.sched + "   " + h.done; }),
        ["TOTAL   " + P.totalSched + "   " + P.totalDone, "", "Last 30 min   " + P.last30, "Last 60 min   " + P.last60], catLines().map(function (x) { return x[0] + "   " + x[1]; }));
    }
    return lines.join("\n");
  }
  // Clipboard first; if the phone refuses, the text goes on screen to long-press.
  async function putOnClipboard(text) {
    try { await navigator.clipboard.writeText(text); toast("Copied"); return; } catch (e) {}
    try {
      var ta = document.createElement("textarea"); ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.top = "-1000px";
      document.body.appendChild(ta); ta.select(); var ok = document.execCommand("copy"); ta.remove();
      if (ok) { toast("Copied"); return; }
    } catch (e) {}
    $("panelBody").innerHTML = '<h2 id="panelTitle">Copy this</h2><textarea id="copyBox" style="height:46vh" readonly>' + esc(text) + '</textarea><div class="pbtns"><button type="button" data-close>Close</button></div>';
    var box = $("copyBox"); box.focus(); box.setSelectionRange(0, text.length);
  }

  // Landing and collection times are typed, not picked: "1320", "13:20",
  // "13.20" and "920" all mean what they say. "" is no time; null is not a time.
  function timeBox(id, value, extra) {
    return '<input id="' + id + '" class="timebox" type="text" inputmode="numeric" maxlength="5" autocomplete="off" placeholder="e.g. 13:20" value="' + esc(value || "") + '"' + (extra || "") + ">";
  }
  function cleanTime(v) {
    var t = String(v || "").trim(); if (!t) return "";
    var m = t.match(/^(\d{1,2})[:.\s]?(\d{2})$/) || t.replace(/\D/g, "").match(/^(\d{1,2})(\d{2})$/);
    if (!m || +m[1] > 23 || +m[2] > 59) return null;
    return pad(+m[1]) + ":" + m[2];
  }
  function readTime(id) { var el = $(id); return el ? cleanTime(el.value) : undefined; }
  // "no flight", "no flight no.", "NOFLIGHT" all mean NO FLIGHT.
  function normFlight(v) { var f = String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); return /^NOFLIGHT/.test(f) ? "NO FLIGHT" : f; }
  // A time on the day nearest the booked return (00:30 on a 23:30 booking is
  // the next morning); for an early return, nearest when it was brought forward.
  // Same rule as set_collect_time / set_sched_time in the database (part 31).
  function collectAt(r, time) {
    var base = r.early ? (r.early_at || nowIso()) : r.return_at;
    if (!base) return null;
    var booked = hhmm(base), diff = (+time.slice(0, 2) * 60 + +time.slice(3)) - (+booked.slice(0, 2) * 60 + +booked.slice(3));
    if (diff < -720) diff += 1440; if (diff > 720) diff -= 1440;
    return new Date(new Date(base).getTime() + diff * 60000).toISOString();
  }
  // sched: the scheduled landing time typed by hand (HH:MM, "" clears it),
  // for when the flights check can't find the flight.
  function setFlight(r, f, collect, sched) {
    if (f !== r.flight) run("set_flight", { p_booking: r.id, p_flight: f }, r, function (x) { x.flight = f; x.sched_at = null; x.sched_time = ""; x.est_at = null; x.est_time = ""; x.flight_status = f === "NO FLIGHT" ? "noflight" : ""; x.flight_note = ""; });
    if (f === "NO FLIGHT" && collect !== undefined && collect !== (r.est_time || "")) run("set_collect_time", { p_booking: r.id, p_time: collect }, r, function (x) { x.est_time = collect; x.est_at = collect ? collectAt(x, collect) : null; x.flight_status = "noflight"; });
    if (f && f !== "NO FLIGHT" && sched !== undefined && sched !== (r.sched_time || "")) run("set_sched_time", { p_booking: r.id, p_time: sched }, r, function (x) {
      x.sched_time = sched; x.sched_at = sched ? collectAt(x, sched) : null;
      if (/check the flight number$/.test(x.flight_note)) x.flight_note = "";
      if (sched && !x.flight_status) x.flight_status = "scheduled"; else if (!sched && x.flight_status === "scheduled") x.flight_status = "";
    });
  }

  // ── quick flight number ───────────────────
  // One car at a time: type it, or tap one of the flights landing near the
  // customer's booked time (from the timetable the flight check keeps).
  var quick = null;
  function missingFlights() {
    return S.rows.filter(function (r) { return r.kind === "drops" && !r.flight && !r.cleared_at; })
      .sort(function (a, b) { return (a.return_at || "9") < (b.return_at || "9") ? -1 : 1; });
  }
  async function openQuickFlight(r, chain) {
    quick = { id: r.id, chain: !!chain, suggest: null, noFlight: false };
    drawQuickFlight();
    if (!$("panel").open) $("panel").showModal();
    setTimeout(function () { var i = $("quickFlight"); if (i) i.focus(); }, 50);
    if (!r.return_at) { quick.suggest = []; return drawQuickFlight(true); }
    var t = new Date(r.return_at).getTime();
    var res = await sb.from("timetable").select("flight, sched_at, origin, status")
      .gte("sched_at", new Date(t - 60 * 60000).toISOString()).lte("sched_at", new Date(t + 60 * 60000).toISOString()).limit(60);
    if (!quick || quick.id !== r.id) return;
    quick.suggest = res.error ? [] : res.data.sort(function (a, b) { return Math.abs(new Date(a.sched_at) - t) - Math.abs(new Date(b.sched_at) - t); }).slice(0, 8);
    drawQuickFlight(true);
  }
  function drawQuickFlight(keepInput) {
    var r = S.rows.filter(function (x) { return x.id === quick.id; })[0]; if (!r) return;
    var typed = keepInput && $("quickFlight") ? $("quickFlight").value : "", typedSched = keepInput && $("quickSched") ? $("quickSched").value : "";
    var left = missingFlights().filter(function (x) { return x.id !== r.id; }).length;
    var chips = quick.suggest === null ? '<div class="hint">Looking for flights near ' + esc(hhmm(r.return_at)) + "…</div>"
      : quick.suggest.length ? '<div class="suggest">' + quick.suggest.map(function (f) {
          return '<button type="button" data-pickflight="' + esc(f.flight) + '" data-picksched="' + esc(hhmm(f.sched_at)) + '"' + (f.status === "cancelled" ? ' class="cx"' : "") + '><b>' + esc(f.flight) + '</b><span class="num">' + esc(hhmm(f.sched_at)) + "</span><small>" + esc(f.origin || "") + (f.status === "cancelled" ? " · cancelled" : "") + "</small></button>";
        }).join("") + "</div>" : "";
    var saveWord = quick.chain && left ? "Save & next (" + left + " left)" : "Save";
    var head = '<h2 id="panelTitle">' + esc(r.reg || "NO REG") + (r.num ? " <small>#" + r.num + "</small>" : "") + "</h2>" +
      '<p class="sub">' + esc(r.name) + " · back " + esc(hhmm(r.return_at)) + "</p>";
    if (quick.noFlight) {
      $("panelBody").innerHTML = head + '<form id="quickForm" novalidate><label for="collectTime">NO FLIGHT NUMBER · COLLECTION TIME</label>' +
        timeBox("collectTime", hhmm(r.return_at), " required") +
        '<div class="pbtns"><button type="button" data-flightback>Back</button><button class="save">' + saveWord + "</button></div></form>";
      return;
    }
    $("panelBody").innerHTML = head +
      '<form id="quickForm" novalidate><label for="quickFlight">FLIGHT NUMBER</label><input id="quickFlight" value="' + esc(typed) + '" autocomplete="off" autocapitalize="characters" maxlength="10" placeholder="e.g. W43451">' +
      '<label for="quickSched">SCHEDULED LANDING (IF KNOWN)</label>' + timeBox("quickSched", typedSched) +
      (chips ? "<label>LANDING NEAR " + esc(hhmm(r.return_at)) + "</label>" + chips : "") +
      '<button type="button" class="noflight" data-noflight>NO FLIGHT NUMBER</button>' +
      '<div class="pbtns"><button type="button" data-close>' + (quick.chain ? "Stop" : "Close") + '</button><button class="save">' + saveWord + "</button></div></form>";
  }
  function saveQuickFlight(value, collect, sched) {
    var r = S.rows.filter(function (x) { return x.id === quick.id; })[0];
    var f = normFlight(value);
    if (!r) return;
    if (!f) { toast("Type the flight number or tap one below.", true); return; }
    if (f === "NO FLIGHT" && !/^\d{2}:\d{2}$/.test(collect || "")) { quick.noFlight = true; drawQuickFlight(); return; }
    if (f === "NO FLIGHT" || !/^\d{2}:\d{2}$/.test(sched || "")) sched = undefined;
    setFlight(r, f, collect, sched);
    toast(r.reg + " · " + f + (collect ? " · " + collect : sched ? " · sched " + sched : ""));
    var next = quick.chain ? missingFlights()[0] : null;
    if (next) return openQuickFlight(next, true);
    quick = null; $("panel").close();
  }

  // ── flights ───────────────────────────────
  var FLIGHT_WORD = { noflight: "No flight number · collection time", "": "Not checked yet", scheduled: "Scheduled", expected: "Running late", airborne: "In the air", delayed: "DELAY", landed: "Landed", cancelled: "CANCELLED" };
  function renderFlights() {
    var sh = sheet();
    if (!sh || sh.kind !== "drops") return '<div class="msg">Choose a DROPS sheet at the top to see its flights.</div>';
    if (!S.runs) loadRuns();
    var all = S.rows.filter(function (r) { return r.flight; }).sort(function (a, b) { return orderAt(a) < orderAt(b) ? -1 : 1; });
    var manual = all.filter(flightToCheck), rows = all.filter(function (r) { return !flightToCheck(r); });
    function n(st) { return rows.filter(function (r) { return r.flight_status === st; }).length; }
    function last(src) {
      var run0 = (S.runs || []).filter(function (x) { return x.source === src; })[0];
      if (!run0) return "never";
      var res = run0.result || {};
      return esc(dayShort(run0.at) + " " + hhmm(run0.at)) + (res.error ? ' · <span class="bad">' + esc(res.error) + "</span>" : "");
    }
    var h = '<div class="pad"><h2 class="title">' + esc(sheetLabel(sh)) + "</h2>" +
      '<div class="stats"><div class="stat"><span>Flights</span><strong class="num">' + all.length + '</strong></div><div class="stat"><span>Landed</span><strong class="num">' + n("landed") +
      '</strong></div><div class="stat"><span>Delayed or late</span><strong class="num">' + (n("delayed") + n("expected")) + '</strong></div><div class="stat"><span>Cancelled</span><strong class="num">' + n("cancelled") +
      '</strong></div></div><p class="note">Timetable last checked: ' + last("schedule") + "<br>Live positions last checked: " + last("live") + "</p>" +
      (can("flights") ? '<div class="row-actions"><button type="button" class="btn small" data-filltimes>Fill &amp; check scheduled times</button><button type="button" class="btn small" data-checkflights>Check flights now</button></div>' : "") +
      "</div>" + missingHtml() + manualHtml(manual) + (missingFlights().length || manual.length ? '<div class="sec">WITH FLIGHT NUMBERS</div>' : "");
    return h + (rows.length ? rows.map(function (r) {
      return '<div class="row' + (r.flight_status === "cancelled" || r.flight_status === "delayed" ? " late" : r.flight_status === "landed" ? " done" : "") + '" data-id="' + r.id + '"><div class="left" data-open><div class="l1"><span class="reg">' + esc(r.flight) + '</span><span class="dn">' + esc(r.reg) + '</span><span class="pin">' + esc(r.name) + "</span></div>" +
        '<div class="l2 num"><span class="l2a">' + esc(FLIGHT_WORD[r.flight_status] || r.flight_status) + (r.flight_note ? " · " + esc(r.flight_note) : "") + '</span><span class="l2b"> · ' + esc(r.sched_time || hhmm(r.return_at)) +
        (r.est_time ? ' &rarr; <span class="eta' + (r.est_time === "DELAY" ? " dly" : "") + '">' + esc(r.est_time) + "</span>" : "") + "</span></div></div></div>";
    }).join("") : '<div class="msg">No flight numbers on this sheet.</div>');
  }
  // Flight numbers the timetable can't find (or TBC): the office checks these by hand.
  function manualHtml(list) {
    if (!list.length) return "";
    return '<div class="sec old">NEED TO CHECK MANUALLY <b class="num">' + list.length + "</b></div>" +
      list.map(function (r) {
        var why = /check the flight number$/.test(r.flight_note) ? r.flight_note.replace(/ · check the flight number$/, "") : "Not a flight number";
        return '<div class="row cmpl" data-id="' + r.id + '"><div class="left" data-open><div class="l1"><span class="reg">' + esc(r.flight) + '</span><span class="dn">' + esc(r.reg) + '</span><span class="pin">' + esc(r.name) + "</span></div>" +
          '<div class="l2 num"><span class="l2a">' + esc(why) + '</span><span class="l2b"> · back ' + esc(hhmm(r.return_at)) + "</span></div></div></div>";
      }).join("");
  }
  function missingHtml() {
    var miss = missingFlights();
    if (!miss.length) return "";
    return '<div class="sec old">NO FLIGHT NUMBER <b class="num">' + miss.length + "</b>" + (can("flights") ? '<span><button type="button" class="btn small" data-fillflights>Add flight numbers</button></span>' : "") + "</div>" +
      miss.map(function (r) {
        return '<div class="row" data-id="' + r.id + '"><div class="left"><div class="l1"><span class="reg">' + esc(r.reg || "NO REG") + "</span>" + (r.num ? '<span class="dn num">#' + r.num + "</span>" : "") + '<span class="pin">' + esc(r.name) + "</span></div>" +
          '<div class="l2 num"><span class="l2a">' + esc(r.make) + '</span><span class="l2b">back ' + esc(hhmm(r.return_at)) + "</span></div></div>" +
          (can("flights") ? '<button type="button" class="addflight" data-addflight>+ FLIGHT</button>' : "") + "</div>";
      }).join("");
  }
  async function loadRuns() {
    S.runs = [];
    var r = await sb.from("flight_runs").select("at, source, trigger, result").order("at", { ascending: false }).limit(20);
    S.runs = r.error ? [] : r.data;
    if (S.view === "flights") render();
  }
  async function fillTimes(btn) {
    var sh = sheet();
    if (!sh || sh.kind !== "drops") return toast("Choose a DROPS sheet first.", true);
    if (btn) btn.disabled = true;
    toast("Checking the timetable…");
    try {
      var s = (await callFunction("flights", { action: "timetable", day: sh.day }, true)).schedule || {};
      var bits = [];
      if (s.skipped) bits.push(s.skipped);
      bits.push((s.filled || 0) + " filled", (s.moved || 0) + " changed");
      if (s.cancelled) bits.push(s.cancelled + " cancelled");
      if (s.expected) bits.push(s.expected + " running late");
      if (s.notfound) bits.push(s.notfound + " not found (check flight no.)");
      if (s.error) bits.push("Problem: " + s.error);
      toast(s.skipped ? s.skipped : bits.join(" · "), !!(s.error || s.skipped));
      S.runs = null; await loadRows(); render();
    } catch (err) { toast(err.message, true); }
    finally { if (btn) btn.disabled = false; }
  }
  async function checkFlights(btn) {
    if (btn) btn.disabled = true;
    toast("Checking flights…");
    try {
      var r = await callFunction("flights", { action: "check" }, true);
      var bits = [], s = r.schedule || {}, l = r.live || {};
      if (s.skipped) bits.push(s.skipped); if (l.skipped) bits.push(l.skipped);
      if (s.filled || s.moved) bits.push((s.filled + s.moved) + " timetable times");
      if (s.cancelled) bits.push(s.cancelled + " cancelled");
      if (l.written) bits.push(l.written + " live ETAs");
      if (l.delayed || s.expected) bits.push((l.delayed || 0) + (s.expected || 0) + " late");
      if (s.error || l.error) bits.push("Problem: " + (s.error || l.error));
      toast(bits.length ? bits.join(" · ") : "Checked. Nothing new: no flights due in the next 90 minutes.", !!(s.error || l.error));
      S.runs = null; await loadRows(); render();
    } catch (err) { toast(err.message, true); }
    finally { if (btn) btn.disabled = false; }
  }

  // ── summary + activity ────────────────────
  function renderSummary() {
    var sh = sheet(), h = "";
    if (sh && can("summary")) {
      if (sh.kind === "drops") {
        var d = S.rows;
        var due = d.filter(function (r) { return /£/.test(r.note); }), D = dropsStats();
        h += '<h2 class="title">' + esc(sheetLabel(sh)) + '</h2><div class="stats"><div class="stat"><span>Cars back</span><strong class="num">' + d.filter(function (r) { return r.cleared_at; }).length + " / " + d.length +
          '</strong></div><div class="stat"><span>On the way</span><strong class="num">' + d.filter(function (r) { return r.sent_at && !r.cleared_at; }).length +
          '</strong></div><div class="stat"><span>Overstays</span><strong class="num">' + d.filter(function (r) { return r.overstay; }).length +
          '</strong></div><div class="stat"><span>Complaints</span><strong class="num">' + d.filter(function (r) { return r.clear_word === "COMPLAINT" || /^!/.test(r.note); }).length +
          '</strong></div><div class="stat"><span>Morning 06:00–18:00</span><strong class="num">' + D.morning.done + " / " + D.morning.due +
          '</strong></div><div class="stat"><span>Night 18:01–05:59</span><strong class="num">' + D.night.done + " / " + D.night.due + "</strong></div></div>" +
          (due.length ? '<div class="section-label">Money due</div><div class="box">' + due.map(function (r) { return '<div class="rowline"><div class="grow"><strong>' + esc(r.reg) + "</strong> · " + esc(r.name) + '<div class="note">' + esc(r.note) + "</div></div></div>"; }).join("") + "</div>" : "");
      } else {
        var p = S.rows, hours = {};
        p.filter(function (r) { return r.intake === "Collected"; }).forEach(function (r) { var k = hhmm(r.intake_at).slice(0, 2); hours[k] = (hours[k] || 0) + 1; });
        h += '<h2 class="title">' + esc(sheetLabel(sh)) + '</h2><div class="stats"><div class="stat"><span>Cars in</span><strong class="num">' + p.filter(function (r) { return r.intake === "Collected"; }).length +
          '</strong></div><div class="stat"><span>No shows</span><strong class="num">' + p.filter(function (r) { return r.intake === "No Show"; }).length +
          '</strong></div><div class="stat"><span>RTC</span><strong class="num">' + p.filter(function (r) { return r.intake === "RTC"; }).length +
          '</strong></div><div class="stat"><span>Still to come</span><strong class="num">' + p.filter(function (r) { return !r.intake; }).length + "</strong></div></div>" +
          '<div class="section-label">Cars in by hour</div><div class="box">' + (Object.keys(hours).sort().map(function (k) { return '<div class="rowline"><span class="num grow">' + k + ':00</span><strong class="num">' + hours[k] + "</strong></div>"; }).join("") || '<div class="empty">None yet.</div>') + "</div>";
      }
    }
    if (can("log")) {
      h += '<div class="section-label">Activity</div>';
      if (!S.activity) { loadActivity(); h += '<div class="empty">Loading…</div>'; }
      else h += S.activity.length ? '<div class="box">' + S.activity.map(function (a) {
        return '<div class="rowline"><span class="num note">' + esc(dayShort(a.at)) + " " + esc(hhmm(a.at)) + '</span><div class="grow"><strong>' + esc(a.action) + "</strong>" + (a.reg ? " · " + esc(a.reg) : "") +
          '<div class="note">' + esc(a.staff_name || "System") + (a.value ? " · " + esc(a.value) : "") + "</div></div></div>";
      }).join("") + '</div><div class="row-actions"><button type="button" class="btn ghost small" data-reloadlog>Refresh</button></div>' : '<div class="empty">Nothing yet.</div>';
    }
    return h || '<div class="empty">Nothing to show for your role.</div>';
  }
  async function loadActivity() {
    var r = await sb.from("activity").select("*").order("at", { ascending: false }).limit(200);
    S.activity = r.error ? [] : r.data; if (r.error) toast(r.error.message, true);
    if (S.view === "summary") render();
  }

  // ── import ────────────────────────────────
  // ── whose app this is ─────────────────────────────────────────────────────
  // One codebase, several parking companies. Each carries its own name, colour
  // and logo in companies.brand, and the page wears them the moment someone
  // signs in — a driver at Airport Parking Bay should never see the word
  // another company's name. Nothing here is per-company code; it is all data.
  var BRAND_KEY = "takeoff_brand";
  var PRODUCT = "Parking Ops";
  function brandName() {
    if (S.company) return String((S.company.brand && S.company.brand.short) || S.company.name || PRODUCT);
    try {
      var c = JSON.parse(localStorage.getItem(BRAND_KEY) || "null");
      if (c) return String((c.brand && c.brand.short) || c.name || PRODUCT);
    } catch (e) {}
    return PRODUCT;
  }
  function brandFullName() {
    if (S.company) return String((S.company.brand && S.company.brand.name) || S.company.name || PRODUCT);
    try {
      var c = JSON.parse(localStorage.getItem(BRAND_KEY) || "null");
      if (c) return String((c.brand && c.brand.name) || c.name || PRODUCT);
    } catch (e) {}
    return PRODUCT;
  }
  function applyBrand(co) {
    var b = (co && co.brand) || {};
    // Remembered on this phone so the NEXT sign-in screen already wears the
    // right name and colour. Without it an Airport Parking Bay driver opens
    // their app and is greeted by another company.
    try { if (co) localStorage.setItem(BRAND_KEY, JSON.stringify({ name: co.name, brand: co.brand || {} })); } catch (e) {}
    var name = String((co && co.name) || b.name || PRODUCT).trim();
    var short = String(b.short || name).trim();

    document.title = name;
    var t = document.querySelector('meta[name="apple-mobile-web-app-title"]');
    if (t) t.setAttribute("content", short);

    // Only the wordmark and the board button. NOT ".brand" on its own: the
    Array.prototype.forEach.call(document.querySelectorAll("span.brand, .tobrand"), function (el) {
      var isGateScreen = el.closest(".gate") !== null;
      el.textContent = isGateScreen ? name : short;
      if (el.classList.contains("tobrand")) el.setAttribute("aria-label", name + " menu");
    });

    if (b.colour) {
      var root = document.documentElement.style;
      root.setProperty("--brand", b.colour);
      if (b.ink) root.setProperty("--brand-ink", b.ink);
      if (b.soft) root.setProperty("--brand-soft", b.soft);
      if (b.text) root.setProperty("--brand-text", b.text);
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", b.colour);
    }
    if (b.logo) {
      Array.prototype.forEach.call(document.querySelectorAll('link[rel="apple-touch-icon"], link[rel="icon"]'), function (l) { l.href = b.logo; });
    }
  }

  // Wear the remembered brand immediately, before anyone signs in.
  try {
    var cached = JSON.parse(localStorage.getItem(BRAND_KEY) || "null");
    if (cached) applyBrand({ name: cached.name, brand: cached.brand });
  } catch (e) {}

  // Then ask the server whose app this actually is, by the address it is served
  // from or the company named in a #setup link. A phone that has never signed
  // in has nothing remembered, and nobody should meet another firm name on
  // their own sign-in screen. Only the name and colour come back.
  async function brandFromServer(key) {
    if (!key) return;
    try {
      var r = await sb.rpc("public_brand", { p_key: key });
      if (r && r.data && r.data.name) applyBrand({ name: r.data.name, brand: r.data.brand });
    } catch (e) {}
  }

  var R = window.TakeoffReader;
  function newImport(kind) { return { kind: kind || "drops", excelFile: null, pdfFile: null, stage: "pick", error: "", cutoff: kind === "picks" ? "00:00" : (S.company.drops_day_end || "06:00").slice(0, 5) }; }
  function shiftKey(dt, cutoff) {
    if (!dt) return "";
    if (!dt.time || cutoff === "00:00" || dt.time > cutoff) return dt.key;
    return addDaysKey(dt.key, -1);
  }
  function renderImport() {
    var I = S.imp || (S.imp = newImport("drops"));
    var h = '<h2 class="title">Import bookings</h2><div class="toolbar"><div class="seg" role="group" aria-label="Sheet type">' +
      '<button type="button" data-impkind="drops" aria-pressed="' + (I.kind === "drops") + '">Drops</button><button type="button" data-impkind="picks" aria-pressed="' + (I.kind === "picks") + '">Picks</button></div></div>';
    if (I.stage !== "preview") {
      var joblist = I.excelFile && /\.pdf$/i.test(I.excelFile.name || "");
      h += '<div class="steps">' + dropZone("excel", "1. Bookings", I.kind === "drops" ? "The booking list covering two days, e.g. 17th to 18th, exactly as downloaded. Excel or a Joblist PDF." : "The booking list for the day, exactly as downloaded. Excel or a Joblist PDF.", I.excelFile) +
        (I.kind === "drops" && !joblist ? dropZone("pdf", "2. Flight numbers (PDF)", "Return Report PDF for the same days. Not needed with a Joblist PDF, which already carries the flights.", I.pdfFile) : "") + "</div>" +
        (I.error ? '<div class="alert" role="alert">' + esc(I.error) + "</div>" : "") +
        '<div class="row-actions"><button type="button" class="btn brand" data-read' + (I.excelFile && I.stage !== "reading" ? "" : " disabled") + ">" + (I.stage === "reading" ? "Reading…" : "Read files") + "</button></div>";
      return h;
    }
    var P = I.preview, miss = P.rows.filter(function (r) { return I.kind === "drops" && !r.flight; }).length;
    var existing = S.sheets.filter(function (s) { return s.kind === I.kind && s.day === P.dateKey; })[0];
    h += '<div class="result"><div><strong class="num">' + P.rows.length + "</strong><span>bookings</span></div>" +
      (I.kind === "drops" ? '<div><strong class="num">' + (P.rows.length - miss) + '</strong><span>flights from the PDF</span></div><div class="' + (miss ? "bad" : "") + '"><strong class="num">' + miss + "</strong><span>need a flight number</span></div>"
        : '<div><strong class="num">' + I.real.dates.length + "</strong><span>day(s) in file</span></div><div></div>") + "</div>" +
      '<div class="inline-selects"><label class="note" for="impDate">' + (I.kind === "drops" ? "Sheet" : "Day") + '</label><select id="impDate" data-impdate>' +
      I.real.dates.map(function (k) { return '<option value="' + k + '"' + (k === P.dateKey ? " selected" : "") + ">" + esc(R.boardName(k, I.kind)) + " · " + I.real.counts[k] + "</option>"; }).join("") + "</select>" +
      (I.kind === "drops" ? '<label class="note" for="impCut">Day ends at</label><select id="impCut" data-impcut>' + ["04:00", "05:00", "06:00", "07:00"].map(function (t) { return "<option" + (t === I.cutoff ? " selected" : "") + ">" + t + "</option>"; }).join("") + "</select>" : "") + "</div>" +
      (existing ? '<div class="alert" style="border-color:var(--brand);background:var(--brand-soft);color:var(--brand-text)">This sheet already exists. Importing again adds new bookings and refreshes details; everything the team has done stays.</div>' : "") +
      '<div class="table-wrap"><table><thead><tr><th>Ref</th><th>Reg</th><th>Customer</th><th>Car</th>' + (I.kind === "drops" ? "<th>Back</th><th>Flight</th>" : "<th>Drop-off</th>") + "</tr></thead><tbody>" +
      P.rows.map(function (r, i) {
        return '<tr class="' + (I.kind === "drops" && !r.flight ? "miss" : "") + '"><td>' + esc(r.ref) + "</td><td>" + esc(r.reg) + "</td><td>" + esc(r.name) + "</td><td>" + esc(r.make) + "</td>" +
          (I.kind === "drops" ? '<td class="num">' + esc(r.ret ? r.ret.time : "") + "</td><td>" + (r.flight ? esc(r.flight) : '<input data-fix="' + i + '" placeholder="U22305" aria-label="Flight for ' + esc(r.reg) + '">') + "</td>" : '<td class="num">' + esc(r.meet ? r.meet.time : "") + "</td>") + "</tr>";
      }).join("") + "</tbody></table></div>" +
      '<div class="row-actions"><button type="button" class="btn ghost" data-restart>Start again</button><button type="button" class="btn brand" data-create' + (I.saving ? " disabled" : "") + ">" + (I.saving ? "Saving…" : "Create " + esc(R.boardName(P.dateKey, I.kind))) + "</button></div>";
    return h;
  }
  function dropZone(key, title, text, file) {
    return '<div class="drop' + (file ? " filled" : "") + '"><strong>' + esc(title) + '</strong><p class="note">' + (file ? "✓ " + esc(file.name) : esc(text)) + "</p>" +
      "<label>" + (file ? "Choose another" : "Choose file") + '<input type="file" data-file="' + key + '" accept="' + (key === "pdf" ? ".pdf" : ".xls,.xlsx,.csv,.txt,.pdf") + '"></label></div>';
  }
  async function readImport() {
    var I = S.imp; I.stage = "reading"; I.error = ""; render();
    try {
      // Two booking systems, two shapes of download. One exports a spreadsheet
      // with a separate flights PDF; the other only exports a PDF, and that PDF
      // is the booking list. Told apart by the file, not by a setting, so the
      // office never has to know which is which.
      var isJoblist = /\.pdf$/i.test(I.excelFile.name || "");
      var xl = isJoblist ? await R.readJoblistPdf(I.excelFile) : await R.readExcel(I.excelFile);
      if (isJoblist && xl.kind && xl.kind !== I.kind) {
        throw new Error("That is a " + xl.kind.toUpperCase() + " sheet, but " + I.kind.toUpperCase() +
          " is selected above. Switch it, or choose the other file.");
      }
      if (!isJoblist && I.kind === "drops" && I.pdfFile) R.matchFlights(xl.rows, await R.readPdf(I.pdfFile), "flightIn");
      I.real = { all: xl.rows };
      groupImport();
      if (!I.real.dates.length) throw new Error("Found " + xl.rows.length + " bookings but no dates in them.");
      var inner = I.real.dates.length >= 3 ? I.real.dates.slice(1, -1) : I.real.dates;
      buildPreview(inner.reduce(function (a, b) { return I.real.counts[b] > I.real.counts[a] ? b : a; }));
    } catch (err) { I.stage = "pick"; I.error = err.message || String(err); render(); }
  }
  function groupImport() {
    var I = S.imp, field = I.kind === "drops" ? "ret" : "meet", counts = {};
    I.real.all.forEach(function (r) { var k = shiftKey(r[field], I.cutoff); if (k) counts[k] = (counts[k] || 0) + 1; });
    I.real.counts = counts; I.real.dates = Object.keys(counts).sort();
  }
  function buildPreview(dateKey) {
    var I = S.imp, field = I.kind === "drops" ? "ret" : "meet";
    var rows = I.real.all.filter(function (r) { return r[field] && shiftKey(r[field], I.cutoff) === dateKey; })
      .sort(function (a, b) { return a[field].date - b[field].date; })
      .map(function (r) { return Object.assign({}, r, { flight: I.kind === "drops" ? (r.flightIn || "") : "" }); });
    I.preview = { dateKey: dateKey, rows: rows }; I.stage = "preview"; render();
  }
  function local(dt) { return dt ? dt.key + " " + (dt.time || "00:00") : ""; }
  async function createSheet() {
    var I = S.imp, P = I.preview;
    I.saving = true; render();
    var rows = P.rows.map(function (r) { return { ref: r.ref, reg: r.reg, name: r.name, phone: r.phone, make: r.make, drop_local: local(r.meet), return_local: local(r.ret), flight: r.flight || "", note: r.note || "" }; });
    var r = await sb.rpc("import_sheet", { p_kind: I.kind, p_day: P.dateKey, p_rows: rows,
      p_source: { excel: I.excelFile && I.excelFile.name, pdf: I.pdfFile && I.pdfFile.name, bookings: rows.length, flights: rows.filter(function (x) { return x.flight; }).length } });
    I.saving = false;
    if (r.error) { toast(r.error.message, true); render(); return; }
    await loadSheets();
    S.sheetId = r.data.sheet_id; S.view = "board"; S.filter = "all"; S.imp = newImport(I.kind);
    await loadRows(); render();
    toast("✓ " + r.data.added + " added" + (r.data.new_marked ? " (" + r.data.new_marked + " marked NEW BOOKING)" : "") + ", " + r.data.updated + " updated" + (r.data.moved ? ", " + r.data.moved + " moved here from an earlier day (return changed)" : "") + ". On every phone now.");
    // A re-import adds and updates but never takes a car away. Cars the booking
    // site no longer lists (usually cancelled) are shown for someone to confirm.
    var inFile = {}; rows.forEach(function (x) { if (x.ref) inFile[x.ref] = 1; });
    // Overstays were carried in from older days and early returns from later
    // ones, so they're never in today's file.
    var gone = S.rows.filter(function (x) { return x.ref && !inFile[x.ref] && !x.overstay && !x.early; });
    if (gone.length) openGone(gone);
  }
  function openGone(gone) {
    panelRow = null;
    $("panelBody").innerHTML = '<h2 id="panelTitle">' + gone.length + (gone.length === 1 ? " car isn't" : " cars aren't") + " in this file any more</h2>" +
      '<p class="sub">They were in an earlier import but this file no longer lists them: cancelled, or the date was changed to another day. Only remove cars you know are cancelled.' +
        (gone[0] && gone[0].kind === "drops" ? " A car whose return moved to another day goes there, with its yard and notes, when that day is imported; removing it here loses them." : "") + '</p>' +
      '<div class="rmlist">' + gone.map(function (r) {
        return '<div><span><b>' + esc(r.reg || "NO REG") + "</b>" + (r.num ? " #" + r.num : "") + " " + esc(r.name) + "<small>Ref " + esc(r.ref) + (r.drop_at ? " · drop " + esc(dayShort(r.drop_at) + " " + hhmm(r.drop_at)) : "") + (r.return_at ? " · back " + esc(dayShort(r.return_at) + " " + hhmm(r.return_at)) : "") +
          '</small></span><button type="button" data-gone="' + r.id + '">Remove as cancelled</button></div>';
      }).join("") + "</div>" +
      '<div class="pbtns"><button type="button" data-close>Keep them</button>' + (gone.length > 1 ? '<button type="button" class="save" data-goneall>Remove all ' + gone.length + " as cancelled</button>" : "") + "</div>";
    if (!$("panel").open) $("panel").showModal();
  }
  async function removeGone(ids, btn) {
    btn.disabled = true;
    for (var i = 0; i < ids.length; i++) {
      var x = await sb.rpc("remove_booking", { p_booking: ids[i], p_reason: "Cancelled" });
      if (x.error) { btn.disabled = false; return toast(x.error.message, true); }
      S.rows = S.rows.filter(function (y) { return y.id !== ids[i]; });
      dropRemoved(ids[i]); S.removed.push(x.data);
    }
    toast(ids.length + (ids.length === 1 ? " car" : " cars") + " removed as cancelled");
    var left = Array.prototype.map.call($("panelBody").querySelectorAll("[data-gone]"), function (b) { return b.dataset.gone; }).filter(function (id) { return ids.indexOf(id) === -1; });
    if (!left.length) return $("panel").close();
    openGone(S.rows.filter(function (y) { return left.indexOf(y.id) !== -1; }));
  }

  // ── staff ─────────────────────────────────
  var ROLE_LABEL = { owner: "Owner", office: "Office", manager: "Manager", bongo: "Bongo driver", terminal: "Terminal", view: "View only" };
  function issuedHtml(x, appName) {
    var msg = "Your " + (appName || brandName()) + " app: " + x.link + " (open it on your phone) Your PIN: " + x.pin;
    return '<div class="issued"><strong>' + esc(x.name) + " · " + esc(ROLE_LABEL[x.role] || x.role) + '</strong><span class="note">Send them this link and PIN. It is shown only once.</span><code>' + esc(x.link) + '</code><div>PIN <span class="pin num">' + esc(x.pin) + "</span></div>" +
      '<div class="row-actions" style="margin:0"><button type="button" class="btn small" data-copy="' + esc(msg) + '">Copy message</button>' +
      '<a class="btn ghost small" href="https://wa.me/?text=' + encodeURIComponent(msg) + '" target="_blank" rel="noopener">WhatsApp</a></div></div>';
  }
  // ── Clients (product owner only, database part 19) ──
  // Counts only: this page never sees a client's customers.
  function renderClients() {
    if (S.clients === undefined) { S.clients = null; loadClients(); }
    var list = S.clients;
    var h = '<div class="clienthead"><h2 class="title">Clients</h2><button type="button" class="btn brand" data-clientedit="new">Add a client</button></div>';
    if (list === null) return h + '<p class="note">Loading…</p>';
    if (list === false) return h + '<div class="msg">Couldn\'t load the clients. Refresh to try again.</div>';
    if (!list.length) return h + '<p class="note">No clients yet.</p>';
    return h + '<div class="clients">' + list.map(function (c) {
      var b = c.brand || {}, host = b.host || "parking-ops.vercel.app";
      var status = c.suspended_at ? '<span class="cstat off">Suspended</span>' : !c.has_owner ? '<span class="cstat wait">Waiting for owner</span>' : '<span class="cstat on">Active</span>';
      var last = c.last_activity ? dayShort(c.last_activity) + " " + hhmm(c.last_activity) : "never";
      return '<div class="client' + (c.suspended_at ? " off" : "") + '"><div class="cl1"><span class="swatch" style="background:' + esc(b.colour || "#334155") + '"></span><strong>' + esc(c.name) + "</strong>" + status + "</div>" +
        '<div class="cmeta">' + esc(c.slug) + " · " + esc(host) + " · yards " + esc((c.yards || []).join(", ")) + "</div>" +
        '<div class="cnums"><div><b class="num">' + c.staff + "</b><span>staff</span></div><div><b class=\"num\">" + c.cars_7d + "</b><span>cars, last 7 days</span></div><div><b class=\"num\">" + c.sheets_7d + "</b><span>sheets, last 7 days</span></div><div><b>" + esc(last) + "</b><span>last activity</span></div></div>" +
        '<div class="row-actions"><button type="button" class="btn ghost small" data-clientedit="' + c.id + '">Edit</button>' +
        (!c.has_owner && !c.suspended_at ? '<button type="button" class="btn brand small" data-clientowner="' + c.id + '">Create first owner</button>' : "") +
        '<button type="button" class="btn ghost small' + (c.suspended_at ? "" : " warn") + '" data-clientsuspend="' + c.id + '">' + (c.suspended_at ? "Resume" : "Suspend") + "</button></div></div>";
    }).join("") + "</div>";
  }
  async function loadClients() {
    var r = await sb.rpc("admin_clients");
    S.clients = r.error ? false : r.data || [];
    if (S.view === "clients") render();
  }
  function hexMix(hex, withHex, amt) {
    var a = parseInt(hex.slice(1), 16), b = parseInt(withHex.slice(1), 16);
    var ch = function (x, y) { return Math.round(x + (y - x) * amt); };
    var r = ch(a >> 16 & 255, b >> 16 & 255), g = ch(a >> 8 & 255, b >> 8 & 255), bl = ch(a & 255, b & 255);
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1).toUpperCase();
  }
  function lightColour(hex) { var n = parseInt(hex.slice(1), 16); return (0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) > 160; }
  function openClient(id) {
    var c = id === "new" ? null : (S.clients || []).filter(function (x) { return x.id === id; })[0];
    var b = (c && c.brand) || {};
    var f = function (key, label, val, attrs, hint) { return '<label for="' + key + '">' + label + '</label><input id="' + key + '" value="' + esc(val || "") + '" autocomplete="off" ' + (attrs || "") + ">" + (hint ? '<p class="hint">' + hint + "</p>" : ""); };
    $("panelBody").innerHTML = '<h2 id="panelTitle">' + (c ? "Edit " + esc(c.name) : "Add a client") + '</h2><form id="clientForm" novalidate data-id="' + (c ? c.id : "") + '">' +
      f("clName", "COMPANY NAME", c && c.name, 'maxlength="80"') +
      f("clShort", "SHORT NAME FOR THE TOP BAR", b.short, 'maxlength="24"', "Leave empty to use the company name.") +
      (c ? '<label>SHORT CODE</label><p class="sub">' + esc(c.slug) + " (fixed: their links are built from it)</p>"
         : f("clSlug", "SHORT CODE", "", 'maxlength="40" autocapitalize="off" placeholder="e.g. airport-parking-bay"', "Lower-case letters, numbers and dashes. Can't be changed later.")) +
      f("clYards", "YARDS", c ? (c.yards || []).join(", ") : "", 'autocapitalize="characters" placeholder="e.g. GS, MY, T"', "Codes separated by commas, 1 to 4 letters each. Add T for the terminal.") +
      f("clEnd", "DROPS DAY ENDS AT", c ? String(c.drops_day_end || "06:00").slice(0, 5) : "06:00", 'type="time"') +
      '<label for="clColour">COLOUR</label><div class="when2"><input id="clColour" type="color" value="' + esc(b.colour || "#334155") + '"><select id="clInk"><option value="#FFFFFF"' + (b.ink !== "#16181D" ? " selected" : "") + '>White text on it</option><option value="#16181D"' + (b.ink === "#16181D" ? " selected" : "") + ">Dark text on it</option></select></div>" +
      f("clHost", "WEB ADDRESS", b.host, 'autocapitalize="off" placeholder="e.g. clientname-ops.vercel.app"', "Add the same address in Vercel (Settings, Domains) or it won't open.") +
      '<div class="pbtns"><button type="button" data-close>Cancel</button><button class="save" id="clGo">' + (c ? "Save" : "Add client") + "</button></div></form>";
    if (!$("panel").open) $("panel").showModal();
    if (!c) {
      $("clColour").addEventListener("input", function () { $("clInk").value = lightColour(this.value) ? "#16181D" : "#FFFFFF"; });
      $("clName").addEventListener("input", function () { if (!$("clSlug").dataset.touched) $("clSlug").value = this.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40); });
      $("clSlug").addEventListener("input", function () { this.dataset.touched = "1"; });
      setTimeout(function () { $("clName").focus(); }, 50);
    }
  }
  async function saveClient() {
    var id = $("clientForm").dataset.id, colour = $("clColour").value.toUpperCase();
    var was = id ? ((S.clients || []).filter(function (x) { return x.id === id; })[0] || {}).brand || {} : {};
    var p = { id: id, name: $("clName").value, slug: $("clSlug") ? $("clSlug").value.trim() : "", drops_day_end: $("clEnd").value,
      yards: $("clYards").value.split(/[\s,]+/).filter(Boolean),
      brand: { short: $("clShort").value, colour: colour, ink: $("clInk").value, soft: hexMix(colour, "#FFFFFF", 0.88), text: hexMix(colour, "#000000", 0.35), host: $("clHost").value.trim().toLowerCase() } };
    // Same colour as before: keep their hand-picked tints rather than recalculating.
    if (was.colour && was.colour.toUpperCase() === colour) { p.brand.soft = was.soft || p.brand.soft; p.brand.text = was.text || p.brand.text; }
    $("clGo").disabled = true;
    var r = await sb.rpc("admin_save_client", { p: p });
    $("clGo").disabled = false;
    if (r.error) return toast(r.error.message, true);
    await loadClients();
    if (id) { toast("Saved"); return $("panel").close(); }
    var host = (r.data.brand && r.data.brand.host) || "parking-ops.vercel.app";
    $("panelBody").innerHTML = '<h2 id="panelTitle">' + esc(r.data.name) + " added</h2>" +
      '<p class="sub">Next steps:</p><ol class="steps"><li>' + (r.data.brand && r.data.brand.host ? "In Vercel, add <b>" + esc(host) + "</b> under Settings, Domains." : "No web address set: they'll use parking-ops.vercel.app.") + "</li>" +
      "<li>On the Clients page, tap <b>Create first owner</b> on " + esc(r.data.name) + ", enter their boss's name, and send the boss the link and PIN it shows.</li></ol>" +
      '<div class="pbtns"><button type="button" data-close>Done</button></div>';
  }
  function askClientOwner(id) {
    var c = (S.clients || []).filter(function (x) { return x.id === id; })[0]; if (!c) return;
    $("panelBody").innerHTML = '<h2 id="panelTitle">First owner for ' + esc(c.name) + '</h2>' +
      '<p class="sub">Their boss. They get a personal link and PIN, and add the rest of their team themselves.</p>' +
      '<form id="clientOwnerForm" data-id="' + c.id + '" novalidate><label for="coName">NAME</label><input id="coName" maxlength="60" autocomplete="off">' +
      '<div class="pbtns"><button type="button" data-close>Cancel</button><button class="save" id="coGo">Create owner</button></div></form><div id="coDone"></div>';
    if (!$("panel").open) $("panel").showModal();
    setTimeout(function () { $("coName").focus(); }, 50);
  }
  async function createClientOwner() {
    var form = $("clientOwnerForm"), name = $("coName").value.trim();
    if (!name) return toast("Enter their boss's name.", true);
    $("coGo").disabled = true;
    try {
      var r = await callFunction("manage-staff", { action: "client_owner", company_id: form.dataset.id, name: name, app_url: location.origin + "/" }, true);
      form.remove();
      var cl = (S.clients || []).filter(function (x) { return x.id === form.dataset.id; })[0] || {};
      $("coDone").innerHTML = issuedHtml(r, (cl.brand && cl.brand.short) || cl.name) + '<div class="pbtns"><button type="button" data-close>Done</button></div>';
      loadClients();
    } catch (err) { $("coGo").disabled = false; toast(err.message, true); }
  }
  async function suspendClient(btn) {
    var c = (S.clients || []).filter(function (x) { return x.id === btn.dataset.clientsuspend; })[0]; if (!c) return;
    var on = !c.suspended_at;
    if (!confirm(on ? "Suspend " + c.name + "? Everyone at " + c.name + " is locked out straight away. Nothing is deleted, and Resume lets them back in." : "Resume " + c.name + "? Their team can sign in again.")) return;
    btn.disabled = true;
    var r = await sb.rpc("admin_suspend_client", { p_id: c.id, p_suspend: on });
    btn.disabled = false;
    if (r.error) return toast(r.error.message, true);
    toast(c.name + (on ? " suspended" : " resumed"));
    loadClients();
  }

  // Mirrors can() in database part 3: what each role gets before any per-person change.
  var ROLE_CAN = { sent: ["office", "manager", "bongo"], called: ["office", "manager"], clear: ["office", "manager", "terminal"], yard: ["office", "manager"],
    summary: ["office", "manager"], log: ["office", "manager"], flights: ["office"], rtc: ["office", "manager", "bongo"], picksinfo: ["office", "manager", "terminal"],
    import: ["office", "manager"], staff: ["office", "manager"], settings: ["manager"] };
  var PERMS = [["sent", "DROPS: press SENT"], ["called", "DROPS: press CALLED and OVERSTAY"], ["clear", "DROPS: press CLEAR and COMPLAINT"], ["yard", "Set yards"],
    ["note", "Write notes"], ["flights", "Enter and check flight numbers"], ["intake", "PICKS: Collected, No show, PT"], ["rtc", "PICKS: RTC"],
    ["picksinfo", "Hourly stats, and PICKS returns"], ["summary", "Summary"], ["log", "Activity log and archive"], ["import", "Import, add and remove cars"],
    ["staff", "Staff: add people, new links, switch off"], ["settings", "Settings"]];
  function roleCan(role, a) { if (role === "owner") return true; var l = ROLE_CAN[a]; return l ? l.indexOf(role) !== -1 : role !== "view"; }
  function personCan(p, a) { var x = p.extra || []; if (x.indexOf("-" + a) !== -1) return false; if (x.indexOf(a) !== -1) return true; return roleCan(p.role, a); }
  function canManage(p) { return (S.me.role === "manager" || S.me.role === "owner") && p.id !== S.me.id && (p.role !== "owner" || S.me.role === "owner"); }
  async function reloadStaff() {
    var list = await sb.from("staff").select("id, name, role, active, created_at, extra, removed_at").order("name");
    if (!list.error) { S.staff = {}; list.data.forEach(function (p) { S.staff[p.id] = p; }); }
  }
  var staffEdit = null;
  function openStaffPanel(id) {
    var p = S.staff[id]; if (!p) return;
    staffEdit = id;
    $("panelBody").innerHTML = '<h2 id="panelTitle">' + esc(p.name) + " <small>" + esc(ROLE_LABEL[p.role] || p.role) + "</small></h2>" +
      '<label>WHAT ' + esc(p.name.toUpperCase()) + ' CAN DO</label><div class="acc">' + PERMS.map(function (x) {
        var d = roleCan(p.role, x[0]);
        return '<label class="chk"><input type="checkbox" data-perm="' + x[0] + '"' + (personCan(p, x[0]) ? " checked" : "") + "><span>" + esc(x[1]) +
          "<small>" + esc(ROLE_LABEL[p.role] || p.role) + " default: " + (d ? "yes" : "no") + "</small></span></label>";
      }).join("") + '</div><div class="pseg" style="margin-top:8px"><button type="button" data-saveaccess>SAVE ACCESS</button><button type="button" data-roledefault>ROLE DEFAULTS</button></div>' +
      '<label for="spPin">SET A NEW PIN</label><div class="when2"><input id="spPin" type="password" inputmode="numeric" maxlength="4" autocomplete="new-password" placeholder="4 numbers"><button type="button" class="btn ghost" data-savepin>Set PIN</button></div>' +
      '<p class="hint">Their link stays the same. Tell them the new PIN.</p>' +
      '<button type="button" class="link rmcar" data-removestaff>Remove ' + esc(p.name) + '</button>' +
      '<div class="pbtns"><button type="button" data-close>Close</button></div>';
    if (!$("panel").open) $("panel").showModal();
  }
  async function staffPanelAction(t) {
    var p = S.staff[staffEdit]; if (!p) return;
    if (t.dataset.roledefault !== undefined) {
      Array.prototype.forEach.call($("panelBody").querySelectorAll("[data-perm]"), function (c) { c.checked = roleCan(p.role, c.dataset.perm); });
      return;
    }
    var r;
    t.disabled = true;
    if (t.dataset.saveaccess !== undefined) {
      var extra = [];
      Array.prototype.forEach.call($("panelBody").querySelectorAll("[data-perm]"), function (c) {
        var a = c.dataset.perm, d = roleCan(p.role, a);
        if (c.checked && !d) extra.push(a); else if (!c.checked && d) extra.push("-" + a);
      });
      r = await sb.rpc("set_staff_access", { p_staff: p.id, p_extra: extra });
      if (!r.error) toast("Access saved for " + p.name + ". It applies next time they open the app.");
    } else if (t.dataset.savepin !== undefined) {
      var pin = $("spPin").value;
      if (!/^\d{4}$/.test(pin)) { t.disabled = false; return toast("The PIN must be 4 numbers.", true); }
      r = await sb.rpc("set_staff_pin", { p_staff: p.id, p_pin: pin });
      if (!r.error) { $("spPin").value = ""; toast("New PIN set for " + p.name + "."); }
    } else if (t.dataset.removestaff !== undefined) {
      if (!confirm("Remove " + p.name + "? Their link and PIN stop working for good. Their name stays on everything they did.")) { t.disabled = false; return; }
      r = await sb.rpc("remove_staff", { p_staff: p.id });
      if (!r.error) { toast(p.name + " removed"); await reloadStaff(); $("panel").close(); render(); return; }
    }
    t.disabled = false;
    if (r && r.error) return toast(r.error.message, true);
    await reloadStaff();
  }
  function renderStaff() {
    var people = Object.keys(S.staff).map(function (k) { return S.staff[k]; }).filter(function (p) { return !p.removed_at; }).sort(function (a, b) { return (b.active - a.active) || a.name.localeCompare(b.name); });
    return '<h2 class="title">Staff</h2>' + (S.issued ? issuedHtml(S.issued) + "<br>" : "") +
      '<form class="box" id="addStaff" style="padding:12px;margin-bottom:14px" novalidate><strong>Add a person</strong>' +
      '<label class="field">Name<input id="newName" maxlength="60" autocomplete="off"></label>' +
      '<label class="field">Role<select id="newRole">' + ["bongo", "terminal", "office", "view"].concat(S.me.role === "owner" || S.me.role === "manager" ? ["manager"] : [], S.me.role === "owner" ? ["owner"] : []).map(function (r) { return '<option value="' + r + '">' + ROLE_LABEL[r] + "</option>"; }).join("") + "</select></label>" +
      '<button class="btn brand" id="addGo">Add and get link</button></form>' +
      '<div class="box">' + people.map(function (p) {
        return '<div class="rowline' + (p.active ? "" : " off") + '"><div class="grow"><strong>' + esc(p.name) + '</strong><div class="note">' + esc(ROLE_LABEL[p.role] || p.role) + (p.active ? "" : " · switched off") + "</div></div>" +
          (p.id === S.me.id ? '<span class="note">You</span>' : (canManage(p) ? '<button type="button" class="btn ghost small" data-manage="' + p.id + '">PIN and access</button>' : "") +
            '<button type="button" class="btn ghost small" data-reset="' + p.id + '">New link</button><button type="button" class="btn ghost small" data-onoff="' + p.id + '">' + (p.active ? "Switch off" : "Switch on") + "</button>") + "</div>";
      }).join("") + "</div>";
  }
  async function staffAction(body, busyEl) {
    if (busyEl) busyEl.disabled = true;
    try {
      body.app_url = location.origin + "/";
      var r = await callFunction("manage-staff", body, true);
      var list = await sb.from("staff").select("id, name, role, active, created_at, extra, removed_at").order("name");
      if (!list.error) { S.staff = {}; list.data.forEach(function (p) { S.staff[p.id] = p; }); }
      return r;
    } catch (err) { toast(err.message, true); return null; }
    finally { if (busyEl) busyEl.disabled = false; }
  }

  // ── archive (owner, manager, office) ──────
  function renderArchive() {
    if (!can("log")) return '<div class="msg">Only the office can open the archive.</div>';
    var A = S.arch || (S.arch = { q: "", results: null, days: null });
    if (!A.days) loadArchiveDays();
    var h = '<form class="box" id="archSearch" style="padding:14px;max-width:640px" novalidate><strong>Find a car on any day</strong><div style="height:8px"></div>' +
      '<div class="toolbar" style="margin:0"><input type="search" id="archQ" value="' + esc(A.q) + '" placeholder="e.g. AB12CDE or LFFLGT" autocomplete="off" style="flex:1 1 180px;min-height:44px;padding:0 12px;border:1px solid var(--line);border-radius:var(--r);font-size:16px">' +
      '<button class="btn small" id="archGo">Search</button></div></form>';
    if (A.results) {
      h += '<div class="section-label">' + (A.results.length ? A.results.length + (A.results.length === 50 ? "+" : "") + " found" : "Nothing found") + "</div>";
      if (A.results.length) h += '<div class="box">' + A.results.map(function (r) {
        var sh = r.sheets || {};
        return '<div class="rowline"><div class="grow"><strong>' + esc(r.reg || "NO REG") + "</strong> · " + esc(r.name || "(details removed)") + '<div class="note">' + esc(sheetLabel({ day: sh.day, kind: sh.kind || r.kind })) + " · " + esc(r.ref) +
          " · " + esc(r.kind === "picks" ? "drop-off " + hhmm(r.drop_at) : "back " + hhmm(r.return_at)) + '</div></div><button type="button" class="btn ghost small" data-archopen="' + r.sheet_id + '" data-archq="' + esc(r.reg || r.ref) + '">Open day</button></div>';
      }).join("") + "</div>";
    }
    var hand = (S.handArchived || []).slice().sort(function (a, b) { return a.day < b.day ? 1 : -1; });
    if (hand.length) {
      h += '<div class="section-label">Archived by hand</div><div class="box">' + hand.map(function (d) {
        return '<div class="rowline"><span class="grow">' + esc(sheetLabel(d)) + '</span><button type="button" class="btn ghost small" data-archopen="' + d.id + '">Open</button>' +
          (can("import") ? '<button type="button" class="btn ghost small" data-unarchive="' + d.id + '">Bring back</button>' : "") + "</div>";
      }).join("") + "</div>";
    }
    h += '<div class="section-label">Days older than ' + PICKER_DAYS + " days</div>";
    if (!A.days || A.daysState === "loading") h += '<div class="msg">Loading…</div>';
    else if (A.daysState === "fail") h += '<p class="note">Couldn\'t load the older days. <button type="button" class="link" data-archretry>Try again</button></p>';
    else if (!A.days.length) h += '<p class="note">None yet.</p>';
    else {
      var months = {};
      A.days.forEach(function (d) { (months[d.day.slice(0, 7)] = months[d.day.slice(0, 7)] || []).push(d); });
      h += Object.keys(months).sort().reverse().map(function (m) {
        return '<details class="box" style="margin-bottom:8px"><summary style="padding:12px;font-weight:700;cursor:pointer">' + new Date(m + "-15T12:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }) +
          ' <span class="note">· ' + months[m].length + " sheets</span></summary>" + months[m].map(function (d) {
            return '<div class="rowline"><span class="grow">' + esc(sheetLabel(d)) + '</span><button type="button" class="btn ghost small" data-archopen="' + d.id + '">Open</button></div>';
          }).join("") + "</details>";
      }).join("");
    }
    return h;
  }
  async function loadArchiveDays() {
    S.arch.days = []; S.arch.daysState = "loading";
    var r = await sb.from("sheets").select("id, kind, day").lt("day", addDaysKey(londonParts(new Date()).key, -PICKER_DAYS)).order("day", { ascending: false }).order("kind").limit(2000);
    S.arch.days = r.error ? [] : r.data; S.arch.daysState = r.error ? "fail" : "ok";
    if (S.view === "archive") render();
  }
  async function searchArchive() {
    var raw = $("archQ").value.trim(), q = raw.replace(/[^A-Za-z0-9 '-]/g, "").trim(), tight = q.replace(/[\s'-]/g, "").toUpperCase();
    S.arch.q = raw;
    if (tight.length < 3) { toast("Type at least 3 letters or numbers.", true); return; }
    $("archGo").disabled = true;
    var r = await sb.from("bookings").select("id, sheet_id, kind, reg, name, ref, drop_at, return_at, sheets!bookings_sheet_id_fkey(day, kind)")
      .or('reg.ilike."%' + tight + '%",ref.ilike."%' + tight + '%",name.ilike."%' + q + '%"').order("updated_at", { ascending: false }).limit(50);
    if (r.error) { toast(r.error.message, true); $("archGo").disabled = false; return; }
    S.arch.results = r.data.sort(function (a, b) { return ((b.sheets || {}).day || "") < ((a.sheets || {}).day || "") ? -1 : 1; });
    render();
  }
  async function openArchived(sheetId, q) {
    if (!S.sheets.some(function (s) { return s.id === sheetId; })) {
      var known = (S.handArchived || []).filter(function (x) { return x.id === sheetId; })[0];
      if (known) { S.archiveSheet = known; S.sheetId = sheetId; S.q = q || ""; S.filter = "all"; S.yardFilter = ""; await loadRows(); return go("board"); }
      var r = await sb.from("sheets").select("id, kind, day, imported_at, source").eq("id", sheetId).maybeSingle();
      if (r.error || !r.data) { toast("Couldn't open that day.", true); return; }
      S.archiveSheet = r.data;
    }
    S.sheetId = sheetId; S.q = q || ""; S.filter = "all"; S.yardFilter = "";
    await loadRows(); go("board");
  }

  async function archiveSheet(id, on) {
    var sh = S.sheets.concat(S.handArchived || [], S.archiveSheet ? [S.archiveSheet] : []).filter(function (x) { return x.id === id; })[0];
    if (!sh) return;
    if (on && !confirm("Archive " + sheetLabel(sh) + "? It leaves the list at the top and stays in Archive.")) return;
    if ($("menu").open) $("menu").close();
    var r = await sb.rpc("archive_sheet", { p_sheet: id, p_archive: on });
    if (r.error) { toast(/archive_sheet/.test(r.error.message) ? "Archiving needs database part 8 first." : r.error.message, true); return; }
    S.archiveSheet = null;
    if (S.arch) S.arch.days = null;
    await loadSheets();
    if (on) { S.sheetId = null; pickDefaultSheet(); await loadRows(); S.view = "board"; }
    else { S.sheetId = id; await loadRows(); }
    render(); toast(sheetLabel(sh) + (on ? " archived" : " is back in the list"));
  }
  async function deleteSheet(id) {
    var sh = S.sheets.concat(S.handArchived || [], S.archiveSheet ? [S.archiveSheet] : []).filter(function (x) { return x.id === id; })[0];
    if (!sh) return;
    var cars = sh.id === S.sheetId ? S.rows.length : null;
    if (!confirm("Delete " + sheetLabel(sh) + (cars !== null ? " and its " + cars + " car(s)" : "") + "?\n\nThis can't be undone. It only works if nobody has tapped, set a yard or typed a note on it.")) return;
    if ($("menu").open) $("menu").close();
    var r = await sb.rpc("delete_sheet", { p_sheet: id });
    if (r.error) { toast(/delete_sheet/.test(r.error.message) ? "Deleting needs database part 8 first." : r.error.message, true); return; }
    if (S.archiveSheet && S.archiveSheet.id === id) S.archiveSheet = null;
    if (S.arch) S.arch.days = null;
    await loadSheets();
    S.sheetId = null; pickDefaultSheet(); await loadRows(); S.view = "board";
    render(); toast(sheetLabel(sh) + " deleted");
  }

  // ── settings (owner and manager) ─────────
  // Flight check timings. The database refuses anything not offered here.
  var TIMING_DEFAULT = { enabled: true, live_every_min: 30, schedule_every_hours: 2, active_from: 6, active_to: 24, before_min: 90, after_hours: 5 };
  function timing() { return Object.assign({}, TIMING_DEFAULT, (S.company && S.company.flight_settings) || {}); }
  function hourName(h) { return h === 24 ? "Midnight (end of day)" : pad(h) + ":00"; }
  function creditGuess(T) {
    // Measured on the Sheet in Aug 2026: live checks every 30 min, 06:00 to
    // midnight, 90 min ahead, cost about 1,900 FR24 credits a day.
    var hours = T.active_from < T.active_to ? T.active_to - T.active_from : 24 - T.active_from + T.active_to;
    return Math.round(1900 * (30 / T.live_every_min) * (hours / 18) * ((T.before_min + 60) / 150) / 50) * 50;
  }
  function renderSettings() {
    if (!can("settings")) return '<div class="msg">Only an owner or manager can change settings.</div>';
    var T = S.settingsDraft || (S.settingsDraft = timing());
    function sel(key, opts, label) {
      return '<label class="field">' + label + '<select data-setting="' + key + '">' + opts.map(function (o) {
        return '<option value="' + o[0] + '"' + (String(T[key]) === String(o[0]) ? " selected" : "") + ">" + esc(o[1]) + "</option>";
      }).join("") + "</select></label>";
    }
    var hrs = []; for (var h = 0; h <= 24; h++) hrs.push([h, hourName(h)]);
    var perDay = creditGuess(T);
    return '<div class="box" style="padding:14px;max-width:560px"><strong>Flight checks</strong>' +
      sel("enabled", [["true", "On"], ["false", "Off: no automatic checks"]], "Automatic checks") +
      (String(T.enabled) === "false" ? "" :
        '<div class="section-label">Live landing times (FlightRadar24)</div>' +
        sel("live_every_min", [[10, "Every 10 minutes"], [15, "Every 15 minutes"], [20, "Every 20 minutes"], [30, "Every 30 minutes"], [45, "Every 45 minutes"], [60, "Every hour"], [90, "Every 90 minutes"], [120, "Every 2 hours"]], "Check every") +
        sel("active_from", hrs.slice(0, 24), "From") + sel("active_to", hrs.slice(1), "Until") +
        sel("before_min", [[30, "30 minutes before landing"], [60, "1 hour before"], [90, "90 minutes before"], [120, "2 hours before"], [180, "3 hours before"], [240, "4 hours before"]], "Start watching a flight") +
        sel("after_hours", [[1, "1 hour after its time"], [2, "2 hours after"], [3, "3 hours after"], [4, "4 hours after"], [5, "5 hours after"], [6, "6 hours after"]], "Give up on a flight not seen") +
        '<div class="section-label">Timetable and cancellations (AeroDataBox)</div>' +
        sel("schedule_every_hours", [[1, "Every hour"], [2, "Every 2 hours"], [3, "Every 3 hours"], [4, "Every 4 hours"], [6, "Every 6 hours"], [12, "Every 12 hours"]], "Check every") +
        // Only speaks up when the settings would run past the monthly plan.
        (perDay > 1900 ? '<div class="alert">About ' + (perDay * 30).toLocaleString("en-GB") + " FlightRadar24 credits a month: more than the 60,000 plan.</div>" : "")) +
      '<div class="row-actions"><button type="button" class="btn ghost" data-resetsettings>Back to defaults</button><button type="button" class="btn brand" data-savesettings>Save</button></div></div>' +
      discordHtml() + ptNumberHtml() + overstayRateHtml() + backupHtml();
  }
  function overstayRateHtml() {
    var rate = +(S.company && S.company.overstay_rate) || 0;
    return '<div class="box" style="padding:14px;margin-top:14px;max-width:560px"><strong>Overstay charges</strong>' +
      '<p class="note">Booked back before ' + esc(((S.company.drops_day_end) || "06:00").slice(0, 5)) + ": free until 12:00 that day, then one day's rate and one more every midnight. Booked back later: free until " + esc(((S.company.drops_day_end) || "06:00").slice(0, 5)) + " the next morning, then one day's rate and one more every morning at that time. 0 switches charging off." + (rate ? " Now: <b>" + money(rate) + " a day</b>." : " Now: <b>off</b>.") + "</p>" +
      '<label class="field">Daily rate (£)<input id="ovRate" type="number" inputmode="decimal" min="0" step="0.5" value="' + rate + '"></label>' +
      '<div class="row-actions"><button type="button" class="btn brand" data-saverate>Save rate</button></div></div>';
  }
  async function saveOverstayRate(btn) {
    btn.disabled = true;
    var r = await sb.rpc("set_overstay_rate", { p_rate: parseFloat($("ovRate").value) || 0 });
    btn.disabled = false;
    if (r.error) return toast(r.error.message, true);
    S.company.overstay_rate = r.data; toast(r.data ? "Saved: " + money(r.data) + " a day" : "Overstay charges off"); render();
  }
  // Owner only: the company's own data, to keep a copy outside the app.
  function backupHtml() {
    if (!S.me || S.me.role !== "owner") return "";
    return '<div class="box" style="padding:14px;margin-top:14px;max-width:560px"><strong>Backup</strong>' +
      '<p class="note">A copy of everything is kept automatically every night for 7 days. To keep one of your own as well, download it and save it somewhere safe, like OneDrive. PINs, links and Discord links are not included.</p>' +
      '<div class="row-actions"><button type="button" class="btn ghost" data-backup>Download a backup</button></div></div>';
  }
  async function downloadBackup(btn) {
    btn.disabled = true;
    var r = await sb.rpc("download_my_company");
    btn.disabled = false;
    if (r.error) return toast(r.error.message, true);
    var blob = new Blob([JSON.stringify(r.data)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (S.company.slug || "company") + "-backup-" + londonParts(new Date()).key + ".json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    S.lastDownload = new Date().toISOString(); if (S.view === "board") render();
    toast("Backup downloaded: " + (r.data.bookings || []).length + " cars. Save it somewhere safe, like OneDrive.");
  }
  function ptNumberHtml() {
    var n = (S.company && S.company.pt_whatsapp) || "";
    return '<div class="box" style="padding:14px;margin-top:14px;max-width:560px"><strong>PT photos: WhatsApp number</strong>' +
      '<p class="note">PT opens this chat with the reg typed, before the photos are sent.' + (n ? " Now: <b>+" + esc(n) + "</b>" : " Not set.") + "</p>" +
      '<label class="field">Number<input id="ptNumber" type="tel" autocomplete="off" placeholder="07932 029349 or +44 7932 029349" value="' + esc(n ? "+" + n : "") + '"></label>' +
      '<div class="row-actions"><button type="button" class="btn brand" data-savept>Save number</button></div>' +
      '<label class="field" style="margin-top:14px">How PT gets the photos<select data-ptmethod>' +
      '<option value="photos"' + (S.company.pt_method !== "link" && S.company.pt_method !== "pdf" ? " selected" : "") + ">In the WhatsApp chat: reg, then the photos (10 at a time on Android)</option>" +
      '<option value="pdf"' + (S.company.pt_method === "pdf" ? " selected" : "") + ">As one PDF with all the photos (one tap)</option>" +
      '<option value="link"' + (S.company.pt_method === "link" ? " selected" : "") + ">As one link to all the photos (only once PT has agreed)</option></select></label></div>";
  }
  async function savePtMethod(sel) {
    var r = await sb.rpc("set_pt_method", { p_method: sel.value });
    if (r.error) { toast(r.error.message, true); return render(); }
    S.company.pt_method = r.data;
    toast(r.data === "link" ? "PT photos now go as a link" : r.data === "pdf" ? "PT photos now go as one PDF" : "PT photos now go in the WhatsApp chat");
  }
  async function savePtNumber(btn) {
    btn.disabled = true;
    var r = await sb.rpc("set_pt_whatsapp", { p_number: $("ptNumber").value });
    btn.disabled = false;
    if (r.error) return toast(r.error.message, true);
    S.company.pt_whatsapp = r.data || "";
    toast(r.data ? "Saved: +" + r.data : "Number removed"); render();
  }
  // Discord links work like passwords for the channel, so the app never shows
  // them back: it only knows whether each one is set.
  function discordHtml() {
    if (S.discord === undefined) { S.discord = null; sb.rpc("discord_status").then(function (r) { S.discord = r.error ? false : r.data; if (S.view === "settings") render(); }); }
    if (S.discord === false) return "";
    var D = S.discord || {};
    function field(key, label) {
      return '<label class="field">' + label + ' <span class="note">' + (S.discord ? (D[key] ? "✓ set" : "not set") : "…") + '</span><input data-discord="' + key + '" type="url" autocomplete="off" placeholder="' + (D[key] ? "Paste a new link to replace it" : "https://discord.com/api/webhooks/…") + '"></label>';
    }
    return '<div class="box" style="padding:14px;margin-top:14px;max-width:560px"><strong>Discord alerts</strong>' +
      field("drops", "DROPS channel") + field("picks", "PICKS channel") +
      '<div class="row-actions">' + (D.drops || D.picks ? '<button type="button" class="btn ghost small" data-discordtest>Send a test to Discord</button><button type="button" class="btn ghost small" data-discordclear>Remove both</button>' : "") +
      '<button type="button" class="btn brand" data-discordsave>Save links</button></div></div>';
  }
  async function saveDiscord(btn, clear) {
    var d = clear ? "" : (document.querySelector('[data-discord="drops"]').value.trim() || null);
    var p = clear ? "" : (document.querySelector('[data-discord="picks"]').value.trim() || null);
    if (!clear && d === null && p === null) { toast("Paste a Discord link first.", true); return; }
    btn.disabled = true;
    var r = await sb.rpc("set_discord", { p_drops: d, p_picks: p });
    btn.disabled = false;
    if (r.error) { toast(r.error.message, true); return; }
    S.discord = r.data; toast(clear ? "Discord links removed" : "Saved"); render();
  }
  async function saveSettings(btn) {
    var T = S.settingsDraft; btn.disabled = true;
    var body = { enabled: String(T.enabled) !== "false" };
    ["live_every_min", "schedule_every_hours", "active_from", "active_to", "before_min", "after_hours"].forEach(function (k) { body[k] = Number(T[k]); });
    var r = await sb.rpc("set_flight_settings", { p: body });
    btn.disabled = false;
    if (r.error) { toast(r.error.message, true); return; }
    S.company.flight_settings = r.data; S.settingsDraft = null;
    toast("Saved. The next automatic check uses the new times.");
    render();
  }

  // ── phone notifications ───────────────────
  // Web push: Android in Chrome, iPhone only when the app is opened from the
  // Home Screen (iOS 16.4+). This public key pairs with VAPID_PRIVATE_KEY, a
  // secret held only by the send-alerts Edge Function.
  var VAPID_PUBLIC_KEY = "BIUvnDQXjj4nWd2EIx7kLAGTTWamJ0oM1V806Ubh7HeiUJfaZWRxwvlUrP7pZTVULpFOYBbWrKtmSC1AmdNtnWw";
  var ALERT_KINDS = [["drops", "DROPS: CALLED, OVERSTAY and COMPLAINT"], ["picks", "PICKS: RTC"], ["flights", "Flight cancelled"]];
  function pushSupported() { return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window; }
  function iosOutsideHomeScreen() { return /iPad|iPhone|iPod/.test(navigator.userAgent) && !(navigator.standalone === true || matchMedia("(display-mode: standalone)").matches); }
  function keyBytes(k) { var raw = atob((k + "=".repeat((4 - k.length % 4) % 4)).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(raw, function (c) { return c.charCodeAt(0); }); }
  async function currentSubscription() {
    if (!pushSupported()) return null;
    var reg = await navigator.serviceWorker.getRegistration("/");
    return reg ? reg.pushManager.getSubscription() : null;
  }
  // S.notify: null until loaded; {ready:false} when part 4 hasn't been run yet.
  async function loadNotify() {
    var prefs = await sb.from("alert_prefs").select("*").maybeSingle();
    var sub = null; try { sub = await currentSubscription(); } catch (e) {}
    S.notify = { ready: !prefs.error, prefs: prefs.data || {}, on: !!sub && pushSupported() && Notification.permission === "granted" };
    if (S.view === "me") render();
  }
  function notifyHtml() {
    var N = S.notify;
    if (!N) { loadNotify(); return '<div class="box" style="padding:14px;margin-top:14px"><strong>Phone notifications</strong><p class="note">Checking…</p></div>'; }
    if (!N.ready) return "";
    var text, canOn = false;
    if (iosOutsideHomeScreen()) text = "On iPhone, add " + brandName() + " to your Home Screen (Share, then Add to Home Screen) and open it from there to get notifications.";
    else if (!pushSupported()) text = "This browser can't show notifications. On Android use Chrome; on iPhone open " + brandName() + " from your Home Screen.";
    else if (Notification.permission === "denied") text = "Notifications are blocked for " + brandName() + ". Allow them in your phone's settings, then come back here.";
    else if (N.on) text = "On for this phone.";
    else { text = "Off for this phone."; canOn = true; }
    return '<div class="box" style="padding:14px;margin-top:14px;max-width:560px"><strong>Phone notifications</strong><p class="note" style="margin:4px 0 10px">' + esc(text) + "</p>" +
      (N.on ? ALERT_KINDS.map(function (k) {
        return '<label class="check"><input type="checkbox" data-alertpref="' + k[0] + '"' + (N.prefs[k[0]] === false ? "" : " checked") + "> " + esc(k[1]) + "</label>";
      }).join("") : "") +
      '<div class="row-actions">' + (canOn ? '<button type="button" class="btn brand" data-notifyon>Turn on notifications</button>' : "") +
      (N.on ? '<button type="button" class="btn ghost small" data-notifytest>Send me a test</button><button type="button" class="btn ghost small" data-notifyoff>Turn off</button>' : "") + "</div></div>";
  }
  async function turnOnNotifications(btn) {
    btn.disabled = true;
    try {
      // Keep this the first await: iPhones only show the prompt straight after a tap.
      var permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error(permission === "denied" ? "Notifications are blocked. Allow them for " + brandName() + " in your phone's settings." : "Notifications weren't allowed.");
      var reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      var sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) }));
      var j = sub.toJSON();
      var r = await sb.rpc("save_push_subscription", { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth });
      if (r.error) throw r.error;
      toast("Notifications are on for this phone");
    } catch (err) { toast(err.message || String(err), true); }
    S.notify = null; render();
  }
  // Also runs quietly on sign-out, so a shared phone stops getting the last person's alerts.
  async function turnOffNotifications(quiet) {
    try {
      var sub = await currentSubscription();
      if (sub) { if (S.me) await sb.rpc("remove_push_subscription", { p_endpoint: sub.endpoint }); await sub.unsubscribe(); }
      if (!quiet) toast("Notifications are off for this phone");
    } catch (err) { if (!quiet) toast(err.message || String(err), true); }
    S.notify = null; if (!quiet) render();
  }
  async function sendTest(btn, discord) {
    btn.disabled = true;
    try {
      var r = await callFunction("send-alerts", { type: "test", discord: !!discord }, true);
      if (discord) toast("Discord: DROPS " + (r.drops ? "sent" : "not set or failed") + " · PICKS " + (r.picks ? "sent" : "not set or failed"), !(r.drops || r.picks));
      else toast(r.sent ? "Test sent. It should arrive in a few seconds." : "Nothing sent: notifications aren't on for this phone.", !r.sent);
    } catch (err) { toast(err.message, true); }
    finally { btn.disabled = false; }
  }

  // ── me ────────────────────────────────────
  // One switch for the company's Discord channel; the links stay saved.
  function discordSwitchHtml() {
    if (!can("settings")) return "";
    if (S.discord === undefined) { S.discord = null; sb.rpc("discord_status").then(function (r) { S.discord = r.error ? false : r.data; if (S.view === "me") render(); }); }
    var D = S.discord;
    if (D === false) return "";
    var head = '<div class="box" style="padding:14px;margin-top:14px"><strong>Discord alerts</strong>';
    if (!D) return head + '<p class="note">Checking…</p></div>';
    if (!D.drops && !D.picks) return head + '<p class="note">Not set up. Add the channel links in Settings.</p></div>';
    var where = [D.drops ? "DROPS" : "", D.picks ? "PICKS" : ""].filter(Boolean).join(" and ");
    return head + '<p class="note">' + (D.paused ? "Off for everyone. The links are kept." : "On. Posting " + where + " alerts to Discord for the whole team.") + "</p>" +
      '<div class="row-actions">' + (D.paused ? '<button type="button" class="btn brand" data-discordpause="0">Turn on Discord alerts</button>'
        : '<button type="button" class="btn ghost" data-discordpause="1">Turn off Discord alerts</button><button type="button" class="btn ghost small" data-discordtest>Send a test</button>') + "</div></div>";
  }
  async function setDiscordPaused(btn, paused) {
    if (paused && !confirm("Turn off Discord alerts for the whole team? Phone notifications carry on.")) return;
    btn.disabled = true;
    var r = await sb.rpc("set_discord_paused", { p_paused: paused });
    btn.disabled = false;
    if (r.error) return toast(r.error.message, true);
    S.discord = r.data; toast(paused ? "Discord alerts off" : "Discord alerts on"); render();
  }
  async function changePin() {
    var old = $("pinOld").value, a = $("pinNew").value, b = $("pinNew2").value;
    if (!/^\d{4}$/.test(old)) return toast("Enter your current 4-number PIN.", true);
    if (!/^\d{4}$/.test(a)) return toast("The new PIN must be 4 numbers.", true);
    if (a !== b) return toast("The two new PINs don't match.", true);
    if (a === old) return toast("That's the PIN you have now.", true);
    $("pinGo2").disabled = true;
    var r = await sb.rpc("change_my_pin", { p_current: old, p_new: a });
    $("pinGo2").disabled = false;
    if (r.error) return toast(r.error.message, true);
    var st = r.data && r.data.status;
    if (st === "bad_pin") { $("pinOld").value = ""; return toast("Current PIN is wrong. " + r.data.left + " tries left before a 15-minute lock.", true); }
    if (st === "locked") return toast("Too many wrong PINs. Try again after " + hhmm(r.data.until) + ".", true);
    ["pinOld", "pinNew", "pinNew2"].forEach(function (id) { $(id).value = ""; });
    toast("PIN changed. Use the new one next time you sign in.");
  }
  function renderMe() {
    return '<h2 class="title">' + esc(S.me.name) + '</h2><p class="note">' + esc(ROLE_LABEL[S.me.role] || S.me.role) + " · " + esc(S.company.name) + "</p>" +
      (S.platform ? "" : notifyHtml() + discordSwitchHtml()) +
      '<form class="box pinbox" id="pinChange" novalidate><strong>Change my PIN</strong><p class="note">Your link stays the same.</p>' +
      '<label>Current PIN<input id="pinOld" type="password" inputmode="numeric" maxlength="4" autocomplete="current-password"></label>' +
      '<label>New PIN<input id="pinNew" type="password" inputmode="numeric" maxlength="4" autocomplete="new-password"></label>' +
      '<label>New PIN again<input id="pinNew2" type="password" inputmode="numeric" maxlength="4" autocomplete="new-password"></label>' +
      '<button class="btn brand" id="pinGo2">Change PIN</button></form>' +
      '<div class="row-actions"><button type="button" class="btn ghost" data-signout>Sign out</button><button type="button" class="btn ghost" data-forget>Sign out and remove my link</button></div>';
  }

  // ── events ────────────────────────────────
  // A personal link opened while this page is already open only changes the hash.
  window.addEventListener("hashchange", function () { if (/^#t=/.test(location.hash) || /^#setup/.test(location.hash)) location.reload(); });

  // ── never a dead screen ──
  // Anything that goes wrong unexpectedly is noted, the person gets a short
  // message (not more than one every few seconds), and the screen is redrawn
  // from what the app knows, so buttons work again. Signal trouble has its own
  // messages and isn't repeated here.
  var lastOops = 0;
  function oopsLog(err) {
    var m = String((err && (err.message || err.reason)) || err || "").slice(0, 300);
    try { console.error(err); } catch (e) {}
    try { var list = JSON.parse(localStorage.getItem("takeoff_errors") || "[]"); list.push({ at: new Date().toISOString(), view: S.view, m: m }); localStorage.setItem("takeoff_errors", JSON.stringify(list.slice(-30))); } catch (e) {}
    return m;
  }
  function oops(err) {
    if (!err) return;
    var m = oopsLog(err);
    if (isNetwork({ message: m }) || /ResizeObserver|Script error/i.test(m)) return;
    if (Date.now() - lastOops > 8000) { lastOops = Date.now(); try { toast("That didn't work. Try again.", true); } catch (e) {} }
    try {
      $("panelBody").querySelectorAll("button[disabled]").forEach(function (b) { if (!b.closest("[data-keepoff]")) b.disabled = false; });
      if (S.me && !$("panel").open) render();
    } catch (e) {}
  }
  window.addEventListener("error", function (e) { if (e.error || e.message) oops(e.error || e.message); });
  window.addEventListener("unhandledrejection", function (e) { oops(e.reason); });

  document.addEventListener("click", async function (e) {
    if (e.target.closest("[data-reload]")) return location.reload();
    // The second line of a row opens the car too, not only the reg.
    var opener = e.target.closest("[data-addflight]") ? null : e.target.closest("div[data-open]");
    if (opener && S.me && !$("panel").open) { var or = rowOf(opener); if (or) return openPanel(or); }
    var t = e.target.closest("button,a"); if (!t) return;
    if (t.dataset.copy) { try { await navigator.clipboard.writeText(t.dataset.copy); toast("Copied"); } catch (err) { toast("Couldn't copy: select the link and copy it", true); } return; }
    if (!S.me) return;
    // The link opens WhatsApp by itself; just remember it was sent.
    // The link opens WhatsApp by itself; PT is done.
    if (t.dataset.ptlink !== undefined) { if (panelRow) ptSent(panelRow); return; }
    // WhatsApp opens on the PT chat with the reg typed; the photos are next.
    if (t.dataset.ptreg !== undefined) { if (pt) { pt.regSent = true; ptStore(); } setTimeout(function () { if (panelRow && pt) openPt(panelRow); }, 400); return; }
    if (t.dataset.savept !== undefined) return savePtNumber(t);
    if (t.dataset.backup !== undefined) return downloadBackup(t);
    if (t.dataset.saverate !== undefined) return saveOverstayRate(t);
    if (t.dataset.view) return go(t.dataset.view);
    if (t.id === "menuBtn") return openMenu();
    if (t.id === "logBtn") return go("summary");
    if (t.id === "flBtn") return checkFlights(t);
    if (t.id === "rtBtn") return openReturns();
    if (t.id === "psBtn") return (sheet() || {}).kind === "drops" ? openDropsStats() : openPicksStats();
    if (t.id === "refreshBtn") { t.disabled = true; await loadSheets(); await loadRows(); S.runs = null; S.activity = null; render(); t.disabled = false; flush(); return; }
    if (t.dataset.checkflights !== undefined) return checkFlights(t);
    if (t.dataset.filltimes !== undefined) return fillTimes(t);
    if (t.dataset.savesettings !== undefined) return saveSettings(t);
    if (t.dataset.archopen) return openArchived(t.dataset.archopen, t.dataset.archq);
    if (t.dataset.archivesheet) return archiveSheet(t.dataset.archivesheet, true);
    if (t.dataset.unarchive) return archiveSheet(t.dataset.unarchive, false);
    if (t.dataset.deletesheet) return deleteSheet(t.dataset.deletesheet);
    if (t.dataset.addcar !== undefined) { $("menu").close(); return openAddCar(); }
    if (t.dataset.manage) return openStaffPanel(t.dataset.manage);
    if (t.dataset.clientedit && S.platform) return openClient(t.dataset.clientedit);
    if (t.dataset.clientsuspend && S.platform) return suspendClient(t);
    if (t.dataset.clientowner && S.platform) return askClientOwner(t.dataset.clientowner);
    if (t.id === "qClear") { S.q = ""; S.other = null; $("q").value = ""; show("qClear", false); $("main").innerHTML = renderBoard(); $("q").focus(); return; }
    if (t.dataset.othersheet) { var oq = t.dataset.otherreg; S.other = null; await openArchived(t.dataset.othersheet, oq); searchOtherDays(); window.scrollTo(0, 0); return; }
    if (t.dataset.removedlist !== undefined) { $("menu").close(); return openRemoved(); }
    if (t.dataset.notifyon !== undefined) return turnOnNotifications(t);
    if (t.dataset.notifyoff !== undefined) return turnOffNotifications(false);
    if (t.dataset.notifytest !== undefined) return sendTest(t, false);
    if (t.dataset.discordtest !== undefined) return sendTest(t, true);
    if (t.dataset.discordpause) return setDiscordPaused(t, t.dataset.discordpause === "1");
    if (t.dataset.discordsave !== undefined) return saveDiscord(t, false);
    if (t.dataset.discordclear !== undefined) { if (confirm("Stop posting " + brandName() + " alerts to Discord?")) saveDiscord(t, true); return; }
    if (t.dataset.resetsettings !== undefined) { S.settingsDraft = Object.assign({}, TIMING_DEFAULT); render(); return; }
    if (t.dataset.filter) { S.filter = t.dataset.filter; render(); return; }
    if (t.dataset.cat) { S.catFilter = S.catFilter === t.dataset.cat ? "" : t.dataset.cat; render(); return; }
    if (t.dataset.tally !== undefined) { S.yardFilter = S.yardFilter === t.dataset.tally ? "" : t.dataset.tally; render(); return; }
    var r = rowOf(t);
    if (r && t.dataset.addflight !== undefined) return openQuickFlight(r, S.view === "flights");
    if (t.dataset.fillflights !== undefined) { var m0 = missingFlights()[0]; if (m0) openQuickFlight(m0, true); return; }
    if (r && t.dataset.open !== undefined) return openPanel(r);
    if (r && t.dataset.act) return tapDrop(r, t.dataset.act);
    if (r && t.dataset.pick) return tapPick(r, "intake", t.dataset.pick);
    if (r && t.dataset.pt !== undefined) {
      if (r.pt_at) return tapPick(r, "pt");
      return ptStart(r);
    }
    if (t.dataset.archretry !== undefined) { S.arch.days = null; render(); return; }
    if (t.dataset.impkind) { S.imp = newImport(t.dataset.impkind); render(); return; }
    if (t.dataset.read !== undefined) return readImport();
    if (t.dataset.restart !== undefined) { S.imp = newImport(S.imp.kind); render(); return; }
    if (t.dataset.create !== undefined) return createSheet();
    if (t.dataset.reloadlog !== undefined) { S.activity = null; render(); return; }
    if (t.dataset.reset) {
      var p = S.staff[t.dataset.reset];
      if (!confirm("Give " + p.name + " a new link and PIN? Their old link stops working.")) return;
      var got = await staffAction({ action: "reset", staff_id: p.id }, t); if (got) { S.issued = got; render(); window.scrollTo(0, 0); } return;
    }
    if (t.dataset.onoff) {
      var q = S.staff[t.dataset.onoff];
      if (q.active && !confirm("Switch off " + q.name + "? They're signed out and can't use the app. Their history stays.")) return;
      if (await staffAction({ action: q.active ? "off" : "on", staff_id: q.id }, t)) { toast(q.name + (q.active ? " switched off" : " switched on")); render(); } return;
    }
    if (t.dataset.signout !== undefined || t.dataset.forget !== undefined) {
      if (S.queue.length && !confirm(S.queue.length + " change(s) haven't saved yet. Sign out anyway?")) return;
      if (t.dataset.forget !== undefined) { try { localStorage.removeItem(LINK_KEY); localStorage.removeItem(BRAND_KEY); } catch (err) {} }
      await turnOffNotifications(true);
      // "Sign out anyway" drops the unsaved changes (notes can hold customer details).
      try { localStorage.removeItem(queueKey()); } catch (err) {}
      S.queue = [];
      S.me = null; teardown(); await sb.auth.signOut(); showSignIn(); return;
    }
  });
  document.addEventListener("submit", async function (e) {
    if (e.target.id === "archSearch") { e.preventDefault(); return searchArchive(); }
    if (e.target.id === "addCarForm") { e.preventDefault(); return addCar(); }
    if (e.target.id === "pinChange") { e.preventDefault(); return changePin(); }
    if (e.target.id === "clientForm") { e.preventDefault(); return saveClient(); }
    if (e.target.id === "clientOwnerForm") { e.preventDefault(); return createClientOwner(); }
    if (e.target.id === "quickForm") {
      e.preventDefault();
      if (quick && quick.noFlight) { var ct = readTime("collectTime"); if (!ct) { toast("Type the collection time like 13:20 (or 1320).", true); return; } return saveQuickFlight("NO FLIGHT", ct); }
      var qs = readTime("quickSched"); if (qs === null) { toast("Type the landing time like 13:20 (or 1320).", true); return; }
      return saveQuickFlight($("quickFlight").value, undefined, qs);
    }
    if (e.target.id !== "addStaff") return;
    e.preventDefault();
    var name = $("newName").value.trim(); if (!name) { toast("Enter the person's name.", true); return; }
    var got = await staffAction({ action: "add", name: name, role: $("newRole").value }, $("addGo"));
    if (got) { S.issued = got; render(); window.scrollTo(0, 0); }
  });
  document.addEventListener("input", function (e) {
    if (e.target.id === "q") { S.q = e.target.value; show("qClear", !!S.q); searchOtherDays(); $("main").innerHTML = renderBoard(); }
  });
  document.addEventListener("change", async function (e) {
    var t = e.target;
    if (t.id === "sheetPick") { S.sheetId = t.value; S.q = ""; S.other = null; S.yardFilter = ""; S.catFilter = ""; S.view = "board"; S.runs = null; await loadRows(); render(); window.scrollTo(0, 0); return; }
    if (t.dataset.yard !== undefined) {
      var r = rowOf(t); if (!r) return;
      var y = t.value;
      t.blur();
      run("set_yard", { p_booking: r.id, p_yard: y }, r, function (x) { x.yard = y; x.yard_before_t = ""; });
      return;
    }
    if (t.dataset.ptfile !== undefined) return ptAdd(t);
    if (t.dataset.ptmethod !== undefined) return savePtMethod(t);
    if (t.dataset.file) { var f = t.files && t.files[0]; if (!f) return; S.imp[t.dataset.file + "File"] = f; S.imp.error = ""; render(); return; }
    if (t.dataset.alertpref !== undefined) {
      var P = Object.assign({ drops: true, picks: true, flights: true }, S.notify.prefs); P[t.dataset.alertpref] = t.checked;
      var pr = await sb.rpc("set_alert_prefs", { p_drops: P.drops !== false, p_picks: P.picks !== false, p_flights: P.flights !== false });
      if (pr.error) { t.checked = !t.checked; toast(pr.error.message, true); } else S.notify.prefs = pr.data;
      return;
    }
    if (t.dataset.setting !== undefined) { S.settingsDraft[t.dataset.setting] = t.value; render(); return; }
    if (t.dataset.shortuntil !== undefined) {
      var sh0 = sheet(), val = t.value || null; t.blur();
      var rr = await sb.rpc("set_short_until", { p_sheet: sh0.id, p_day: val });
      if (rr.error) { toast(/set_short_until/.test(rr.error.message) ? "Short dates need database part 6 first." : rr.error.message, true); }
      else { Object.assign(sh0, rr.data); if (!val && /^(short|long)/.test(S.catFilter)) S.catFilter = ""; }
      render(); return;
    }
    if (t.dataset.impdate !== undefined) return buildPreview(t.value);
    if (t.dataset.impcut !== undefined) { S.imp.cutoff = t.value; var keep = S.imp.preview.dateKey; groupImport(); buildPreview(S.imp.real.dates.indexOf(keep) !== -1 ? keep : S.imp.real.dates[0]); return; }
    if (t.dataset.fix !== undefined) {
      var v = normFlight(t.value);
      if (v) { S.imp.preview.rows[+t.dataset.fix].flight = v; render(); }
    }
  });

  // ── menu ──────────────────────────────────
  function openMenu() {
    if (S.platform) {
      $("menuBody").innerHTML = "<h2>Parking Ops</h2><p class=\"sub\">" + esc(S.me.name) + " · product owner</p><div class=\"menu-list\">" +
        [["clients", "Clients"], ["me", "Me · sign out"]].map(function (x) { return '<button type="button" data-view="' + x[0] + '"' + (S.view === x[0] ? ' aria-current="page"' : "") + ">" + x[1] + "</button>"; }).join("") +
        '</div><div class="pbtns"><button type="button" data-closemenu>Close</button></div>';
      return $("menu").showModal();
    }
    var items = [["board", "Board", true], ["flights", "Flights", true], ["summary", "Summary and activity", can("summary") || can("log")], ["archive", "Archive: older days and search", can("log")],
      ["import", "Import bookings", can("import")], ["staff", "Staff", can("staff")], ["settings", "Settings", can("settings")], ["me", "Me · sign out", true]];
    var sh = sheet();
    var sheetTools = sh && can("import") ? '<label>THIS SHEET · ' + esc(sheetLabel(sh)) + '</label><div class="menu-list">' +
      '<button type="button" data-addcar>Add a car</button>' +
      '<button type="button" data-removedlist>Removed cars' + ((S.removed || []).length ? " (" + S.removed.length + ")" : "") + "</button>" +
      (sh.archived_at ? '<button type="button" data-unarchive="' + sh.id + '">Bring back to the list</button>' : '<button type="button" data-archivesheet="' + sh.id + '">Archive this sheet</button>') +
      '<button type="button" class="danger" data-deletesheet="' + sh.id + '">Delete this sheet</button></div>' : "";
    $("menuBody").innerHTML = "<h2>" + esc(S.company.name) + '</h2><p class="sub">' + esc(S.me.name) + " · " + esc(ROLE_LABEL[S.me.role] || S.me.role) + "</p>" +
      '<div class="menu-list">' + items.filter(function (x) { return x[2]; }).map(function (x) {
        return '<button type="button" data-view="' + x[0] + '"' + (S.view === x[0] ? ' aria-current="page"' : "") + ">" + x[1] + "</button>";
      }).join("") + "</div>" + sheetTools + '<div class="pbtns"><button type="button" data-closemenu>Close</button></div>';
    $("menu").showModal();
  }
  $("menu").addEventListener("click", function (e) { if (outside("menu", e) || e.target.closest("[data-closemenu]")) $("menu").close(); });
  // The clock, and the CALLED colours that change with waiting time.
  setInterval(function () {
    if (!S.me) return;
    $("clock").textContent = londonParts(new Date()).time;
    if (S.view === "board" && !$("panel").open && !yardOpen() && document.activeElement !== $("q")) render();
  }, 60000);

  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("/sw.js").catch(function () {});
  start().catch(function (err) { oopsLog(err); bootTrouble(); });
})();
