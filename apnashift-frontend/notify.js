/* BookingNotify — browser notifications for new bookings (driver + admin).
 *
 * - Never throws into page code: every public function guards itself.
 * - Permission is requested ONLY from an explicit user click (toggle).
 *   Pages must never auto-prompt on load.
 * - Dedupe by tag: one order notifies at most once (no spam on reconnect).
 * - Sound is optional and OFF by default; WebAudio two-tone beep, no asset file.
 * - Plain <script src> include; same-origin so CSP 'self' allows it.
 * - Passes ONLY caller-supplied title/body through — adds no data itself,
 *   so notification content stays as safe as the server event behind it.
 */
(function (global) {
  "use strict";

  var notified = {}; // tag -> timestamp ms (dedupe)
  var MAX_TAGS = 200;
  var audioCtx = null;

  function supported() {
    try {
      return typeof global.Notification !== "undefined";
    } catch (e) {
      return false;
    }
  }

  function permission() {
    try {
      if (!supported()) return "unsupported";
      return global.Notification.permission || "default";
    } catch (e) {
      return "unsupported";
    }
  }

  // Call ONLY from a real click handler (browser needs user activation).
  function ensurePermission() {
    try {
      if (!supported()) return Promise.resolve("unsupported");
      if (global.Notification.permission === "granted") return Promise.resolve("granted");
      if (global.Notification.permission === "denied") return Promise.resolve("denied");
      return global.Notification.requestPermission().then(
        function (p) {
          return p || "default";
        },
        function () {
          return "default";
        }
      );
    } catch (e) {
      return Promise.resolve("unsupported");
    }
  }

  function prune() {
    try {
      var keys = Object.keys(notified);
      if (keys.length <= MAX_TAGS) return;
      var cutoff = Date.now() - 24 * 3600 * 1000;
      for (var i = 0; i < keys.length; i++) {
        if (notified[keys[i]] < cutoff) delete notified[keys[i]];
      }
        } catch (e) { /* ignore — audio resume best-effort hai */ }
  }

  function notify(opts) {
    try {
      opts = opts || {};
      var tag = String(opts.tag || "");
      if (!tag) return false;
      if (notified[tag]) return false; // already shown — never spam twice
      if (!supported() || global.Notification.permission !== "granted") return false;
      var n = new global.Notification(opts.title || "ApnaShift", {
        body: String(opts.body || ""),
        tag: tag,
        renotify: false,
      });
      notified[tag] = Date.now();
      prune();
      if (typeof opts.onClick === "function") {
        n.onclick = function () {
          try {
            opts.onClick();
    } catch (e) { /* ignore — best-effort dedupe cleanup */ }
        };
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function beep() {
    try {
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return false;
      if (!audioCtx) {
        try {
          audioCtx = new AC();
        } catch (e) {
          return false;
        }
      }
      if (audioCtx.resume) {
        try {
          var pr = audioCtx.resume();
          if (pr && pr.catch) pr.catch(function () {});
          } catch (e) { /* ignore — click handler optional hai */ }
      }
      var now = audioCtx.currentTime || 0;
      tone(880, now, 0.12);
      tone(1174.66, now + 0.14, 0.16);
      return true;
    } catch (e) {
      return false;
    }
  }

  function tone(freq, t0, dur) {
    var o = audioCtx.createOscillator();
    var g = audioCtx.createGain();
    o.type = "sine";
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.5, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  function storage() {
    try {
      return global.localStorage || null;
    } catch (e) {
      return null;
    }
  }

  function loadPrefs() {
    try {
      var s = storage();
      if (!s) return { alerts: false, sound: false };
      var raw = s.getItem("apnashift_notify_prefs");
      if (!raw) return { alerts: false, sound: false };
      var p = JSON.parse(raw);
      return { alerts: !!p.alerts, sound: !!p.sound };
    } catch (e) {
      return { alerts: false, sound: false };
    }
  }

  function savePrefs(prefs) {
    try {
      var s = storage();
      if (!s) return false;
      s.setItem(
        "apnashift_notify_prefs",
        JSON.stringify({ alerts: !!(prefs && prefs.alerts), sound: !!(prefs && prefs.sound) })
      );
      return true;
    } catch (e) {
      return false;
    }
  }

  // Test hook (not used by pages): clears dedupe memory.
  function __resetForTests() {
    notified = {};
    audioCtx = null;
  }

  global.BookingNotify = {
    supported: supported,
    permission: permission,
    ensurePermission: ensurePermission,
    notify: notify,
    beep: beep,
    loadPrefs: loadPrefs,
    savePrefs: savePrefs,
    __resetForTests: __resetForTests,
  };
})(typeof window !== "undefined" ? window : this);
