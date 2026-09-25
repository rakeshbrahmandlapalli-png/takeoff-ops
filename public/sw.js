// TakeOff: keeps the app's own files on the phone so it opens with no signal.
// Bookings are never cached here; they come from Supabase every time.
const CACHE = "takeoff-ops-v3";
const FILES = ["/", "/index.html", "/app.css", "/app.js", "/reader.js", "/vendor/supabase-2.117.2.js", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png"];
self.addEventListener("install", e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== CACHE).map(x => caches.delete(x)))).then(() => self.clients.claim())));
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  // Newest copy from the network, but on a weak signal the saved copy after
  // 4 seconds, so the app never sits on a blank screen waiting.
  const net = fetch(e.request).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  });
  const saved = () => caches.match(e.request).then(hit => hit || (e.request.mode === "navigate" ? caches.match("/index.html") : undefined));
  const slow = new Promise(ok => setTimeout(ok, 4000)).then(saved);
  e.respondWith(Promise.race([net.catch(saved), slow.then(hit => hit || net)]).then(res => res || net).catch(saved));
});

// Alerts from send-alerts: {title, body, url, tag}. iPhones require every push
// to show a notification, so one is always shown.
self.addEventListener("push", e => {
  let note = {};
  try { note = e.data ? e.data.json() : {}; } catch (err) { note = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(note.title || "TakeOff", {
    body: note.body || "", tag: note.tag || undefined, renotify: !!note.tag,
    icon: "/icons/icon-192.png", badge: "/icons/badge.png", data: { url: note.url || "/" }
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    const open = list.find(c => c.url.split("#")[0] === target);
    return open ? open.focus() : self.clients.openWindow(target);
  }));
});
