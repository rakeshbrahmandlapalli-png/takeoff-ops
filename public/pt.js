// The PT photos page (/p/<token>): shows one link's photos, one by one or as a zip.
(function () {
  "use strict";
  var FN = "https://oioqjfrlwrjovnouhusp.supabase.co/functions/v1/pt-photos";
  var KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9pb3FqZnJsd3Jqb3Zub3VodXNwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk2Mjk3MDQsImV4cCI6MjEwNTIwNTcwNH0.09ddpfS4_KwZN7QWJoAiwaIl02wQLaw6yJWEltNMQ2U";
  var $ = function (id) { return document.getElementById(id); };
  var token = (location.pathname.match(/^\/p\/([A-Za-z0-9_-]{22,64})\/?$/) || [])[1] || new URLSearchParams(location.search).get("t") || "";
  var data = null, at = 0;
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function when(iso) { return iso ? new Date(iso).toLocaleString("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : ""; }
  function fail(msg) { $("meta").textContent = ""; $("grid").innerHTML = '<div class="msg">' + esc(msg) + "</div>"; }

  fetch(FN, { method: "POST", headers: { "Content-Type": "application/json", apikey: KEY, Authorization: "Bearer " + KEY }, body: JSON.stringify({ action: "view", token: token }) })
    .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || "Couldn't load the photos."); return j; }); })
    .then(function (j) {
      data = j;
      document.title = (j.reg || "PT") + " · PT photos";
      $("reg").textContent = j.reg || "NO REG";
      $("meta").textContent = j.photos.length + " photo" + (j.photos.length === 1 ? "" : "s") + " · " + when(j.created_at) + (j.by ? " · " + j.by : "") + (j.company ? " · " + j.company : "");
      $("hint").textContent = j.photos.length ? "Tap a photo to see it full size. Pinch or tap Zoom to look closer." : "";
      $("grid").innerHTML = j.photos.map(function (p, i) {
        return '<a href="' + esc(p.url) + '" data-i="' + i + '"><img loading="lazy" src="' + esc(p.url) + '" alt="Photo ' + (i + 1) + '"><span>' + (i + 1) + "</span></a>";
      }).join("") || '<div class="msg">No photos in this link.</div>';
      $("all").disabled = !j.photos.length;
    })
    .catch(function (e) { fail(e.message || String(e)); });

  $("grid").addEventListener("click", function (e) {
    var a = e.target.closest("a[data-i]"); if (!a) return;
    e.preventDefault(); show(+a.dataset.i);
  });
  function show(i) {
    var p = data.photos; at = (i + p.length) % p.length;
    $("big").classList.remove("full"); $("big").src = p[at].url; $("save").href = p[at].download;
    $("zoom").textContent = "Zoom"; $("view").classList.add("on");
  }
  $("prev").onclick = function () { show(at - 1); };
  $("next").onclick = function () { show(at + 1); };
  $("close").onclick = function () { $("view").classList.remove("on"); $("big").src = ""; };
  $("zoom").onclick = function () { var f = $("big").classList.toggle("full"); this.textContent = f ? "Fit" : "Zoom"; };
  document.addEventListener("keydown", function (e) {
    if (!$("view").classList.contains("on")) return;
    if (e.key === "ArrowLeft") show(at - 1); else if (e.key === "ArrowRight") show(at + 1); else if (e.key === "Escape") $("close").onclick();
  });

  // All photos in one zip, named REG-01.jpg, REG-02.jpg...
  $("all").onclick = async function () {
    var b = this, p = data.photos; b.disabled = true;
    try {
      var zip = new JSZip();
      for (var i = 0; i < p.length; i++) {
        b.textContent = "Getting " + (i + 1) + " of " + p.length + "…";
        var r = await fetch(p[i].url); if (!r.ok) throw new Error("Photo " + (i + 1) + " didn't download.");
        zip.file(p[i].name, await r.blob(), { binary: true });
      }
      b.textContent = "Zipping…";
      var blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
      var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = (data.reg || "PT").replace(/[^A-Za-z0-9]/g, "") + "-photos.zip";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
      b.textContent = "Download all";
    } catch (e) { b.textContent = "Download all"; alert(e.message || String(e)); }
    b.disabled = false;
  };
})();
