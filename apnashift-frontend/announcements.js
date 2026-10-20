/* ApnaShift — announcement banners (customer website + driver dashboard).
 *
 * Page load par GET /api/announcements/active ek baar; body ke top par
 * sticky strip stack banata hai:
 *   - Maintenance block (deepOrange, 🛠, non-dismissible) jab tak
 *     maintenance.active true hai, aur
 *   - Active announcements (severity color, ✕ = per-id dismiss localStorage
 *     key `apnashift-ann-dismissed` me persist).
 * show_banner=false, maintenance_mode rows (wo alag strip me aati hain) aur
 * start_at/end_at window client clock se check hoti hai. Audience token se:
 * apnashift_driver_token → driver, apnashift_user_token → user, warna
 * sirf 'all' rows (guest parity). Sirf textContent use hota hai — koi
 * innerHTML-with-server-strings nahi. api-config.js ke baad include karo.
 * Network fail = chup (banner best-effort, page ko kabhi todta nahi).
 * Har 5 min par refresh (C6) + tab visible hone par ek baar — naye publish/
 * expiry/waqt ki window ko page khud follow karti hai (koi socket nahi).
 */
(function (global) {
  "use strict";

  var DISMISS_KEY = "apnashift-ann-dismissed";
  var SEV = {
    info: { c: "#1d4ed8", i: "\u2139" },
    warning: { c: "#c2410c", i: "\u26a0" },
    critical: { c: "#b91c1c", i: "\u2716" },
    maintenance: { c: "#c2410c", i: "\ud83d\udee0" }
  };
  var FALLBACK = "Maintenance in progress \u2014 bookings will resume shortly.";

  function store() {
    try {
      return global.localStorage || null;
    } catch (e) {
      return null;
    }
  }

  function storage2() {
    try {
      return global.sessionStorage || null;
    } catch (e) {
      return null;
    }
  }

  function dismissed() {
    try {
      var s = store();
      if (!s) return {};
      var raw = s.getItem(DISMISS_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      var map = {};
      if (arr && arr.length) {
        for (var i = 0; i < arr.length; i++) map[String(arr[i])] = true;
      }
      return map;
    } catch (e) {
      return {};
    }
  }

  function addDismissed(id) {
    try {
      var s = store();
      if (!s) return;
      var map = dismissed();
      map[id] = true;
      s.setItem(DISMISS_KEY, JSON.stringify(Object.keys(map)));
    } catch (e) {
      /* private mode — dismiss sirf is session tak */
    }
  }

  function base() {
    var b = global.API_BASE_URL;
    return typeof b === "string" ? b : "";
  }

  // Token se audience (backend user|driver → users|drivers khud map karta
  // hai). Guest = null → sirf universal 'all' rows (app parity).
  function audience() {
    try {
      var ls = store(), ss = storage2();
      var has = function (k) {
        return !!((ls && ls.getItem(k)) || (ss && ss.getItem(k)));
      };
      if (has("apnashift_driver_token")) return "driver";
      if (has("apnashift_user_token")) return "user";
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  function inWindow(a) {
    var now = Date.now();
    try {
      if (a.start_at) {
        var s = Date.parse(a.start_at);
        if (!isNaN(s) && now < s) return false;
      }
      if (a.end_at) {
        var e = Date.parse(a.end_at);
        if (!isNaN(e) && now >= e) return false;
      }
      return true;
    } catch (err) {
      return true;
    }
  }

  function hexA(hex, alpha) {
    var r = parseInt(hex.substr(1, 2), 16),
      g = parseInt(hex.substr(3, 2), 16),
      b = parseInt(hex.substr(5, 2), 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return "rgba(30,64,175," + alpha + ")";
    return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
  }

  function strip(opts) {
    var d = document.createElement("div");
    d.style.cssText =
      "display:flex;gap:8px;align-items:flex-start;padding:6px 4px 6px 12px;background:" +
      opts.bg +
      ";border-bottom:1px solid rgba(0,0,0,.08);";
    var ic = document.createElement("span");
    ic.textContent = opts.icon;
    ic.style.cssText = "font-size:14px;line-height:1.5;color:" + opts.color + ";";
    d.appendChild(ic);
    var box = document.createElement("div");
    box.style.cssText = "flex:1;min-width:0;";
    var t = document.createElement("div");
    t.textContent = opts.title;
    t.style.cssText =
      "font-size:12.5px;font-weight:800;color:" + opts.color + ";overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    box.appendChild(t);
    var b = document.createElement("div");
    b.textContent = opts.body;
    b.style.cssText = "font-size:12.5px;line-height:1.4;white-space:pre-wrap;word-break:break-word;";
    box.appendChild(b);
    d.appendChild(box);
    if (opts.onClose) {
      var x = document.createElement("button");
      x.type = "button";
      x.textContent = "\u2715";
      x.setAttribute("aria-label", "Close");
      x.style.cssText =
        "border:0;background:transparent;font-size:14px;cursor:pointer;padding:4px 8px;color:#444;flex:none;";
      x.onclick = opts.onClose;
      d.appendChild(x);
    }
    return d;
  }

  var last = null;

  function render(data) {
    try {
      if (!document.body) return;
      var host = document.getElementById("apnashift-announcements");
      if (!host) {
        host = document.createElement("div");
        host.id = "apnashift-announcements";
        host.style.cssText = "position:sticky;top:0;z-index:60;";
        document.body.insertBefore(host, document.body.firstChild);
      }
      while (host.firstChild) host.removeChild(host.firstChild); // apna khali container
      if (!data || data.ok !== true) return;
      var m = data.maintenance || {};
      if (m.blocked) {
        host.appendChild(
          strip({
            color: "#c2410c",
            icon: "\ud83d\udee0",
            title: "Maintenance",
            body: String(m.message || FALLBACK),
            bg: hexA("#c2410c", 0.14),
            onClose: null
          })
        );
      }
      var gone = dismissed();
      var items = data.items || [];
      for (var i = 0; i < items.length; i++) {
        var a = items[i];
        if (!a || typeof a !== "object") continue;
        if (a.show_banner === false) continue;
        if (a.maintenance_mode === true) continue;
        var id = String(a.id);
        if (gone[id]) continue;
        if (!inWindow(a)) continue;
        var sev = SEV[a.severity] || SEV.info;
        host.appendChild(
          strip({
            color: sev.c,
            icon: sev.i,
            title: String(a.title || ""),
            body: String(a.body || ""),
            bg: hexA(sev.c, 0.12),
            onClose: (function (fid) {
              return function () {
                addDismissed(fid);
                render(last);
              };
            })(id)
          })
        );
      }
    } catch (e) {
      /* kabhi page par throw nahi */
    }
  }

  var busy = false;

  function refresh() {
    if (busy) return;
    busy = true;
    try {
      var aud = audience();
      var url = base() + "/api/announcements/active" + (aud ? "?audience=" + aud : "");
      global
        .fetch(url, { headers: { Accept: "application/json" } })
        .then(function (r) {
          return r.json();
        })
        .then(function (d) {
          last = d;
          render(d);
        })
        .catch(function () {
          /* best-effort — chup reh */
        })
        .then(function () {
          busy = false;
        });
    } catch (e) {
      busy = false;
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", refresh);
  } else {
    refresh();
  }

  // Periodic refresh (C6): 5-min ticker + tab wapas visible par.
  setInterval(refresh, 5 * 60 * 1000);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) refresh();
  });

  global.ApnaShiftAnnouncements = { refresh: refresh };
})(typeof window !== "undefined" ? window : this);
