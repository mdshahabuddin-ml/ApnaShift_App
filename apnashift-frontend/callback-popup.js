/* ApnaShift — "Moving Soon?" callback popup (first-visit lead capture).
 *
 * Naya visitor (guest, pehli baar) page load par ye modal khud dikhata hai —
 * koi button click nahi chahiye. Reference design: centered white card +
 * dark overlay, "Moving Soon?" heading, ✕ close, 4 stacked fields
 * (From City, To City, Your Name, Phone Number*) — pehle field ka orange
 * focus border — aur full-width orange "Get a Callback" button.
 *
 * First-visit policy (config):
 *   - guestsOnly: true       → sirf logged-out visitor (koi token nahi)
 *   - reshowAfterDays: 0     → sirf ek baar (0 = kabhi dobara nahi);
 *                              >0 = dismiss ke utne din baad dobara
 *   - State localStorage key `apnashift-callback-popup` me JSON
 *     {"s":"shown"|"dismissed"|"submitted","t":epochMs} — isliye har page
 *     navigation/refresh par dobara nahi aata. Storage blocked ho to
 *     sessionStorage fallback (session me ek hi baar).
 *
 * Submit: required validation + Indian mobile ([6-9] + 9 digit, +91/91/0
 * prefix normalize) → success card + WhatsApp handoff
 * (wa.me/918757160137, help.html/enterprise.html parity — koi naya
 * backend/DB endpoint nahi). Status "submitted" = kabhi dobara nahi aata.
 *
 * Close: ✕ / backdrop click / Escape — body scroll restore guaranteed,
 * navigation kabhi block nahi. Overlay sirf tabhi hota hai jab modal khula ho.
 *
 * Style rules compound (2+ class) selectors use karte hain taaki theme.js ke
 * dark-mode element rules (html[data-theme] input/h2/…) ko na chhuedein —
 * popup hamesha white card (reference design) rahta hai, dark mode me bhi.
 * text-size.js ki A+/A- scaling isi tarah apply hoti hai (site-wide parity).
 *
 * Page-level override (script load se pehle):
 *   window.ApnaShiftCallbackPopupConfig = { reshowAfterDays: 30, showDelayMs: 0 };
 *
 * API: window.ApnaShiftCallbackPopup = { open, close, shouldShow, reset }
 * Include: public pages me <script src="callback-popup.js"></script>
 * (api-config.js ki zaroorat nahi — ye wa.me use karta hai).
 * Network/parse fail par kabhi page par throw nahi (announcements.js pattern).
 */
/* global window, document */
(function (global) {
  "use strict";
  if (global.ApnaShiftCallbackPopup) return;

  var STORAGE_KEY = "apnashift-callback-popup";
  var SESSION_KEY = "apnashift-callback-popup-session";
  var WHATSAPP = "918757160137";
  var PHONE_RE = /^[6-9]\d{9}$/;
  var DAY_MS = 24 * 60 * 60 * 1000;

  var CFG = {
    enabled: true,
    guestsOnly: true,
    showDelayMs: 600,
    reshowAfterDays: 0, // 0 = first-visit policy: ek hi baar
    whatsapp: WHATSAPP
  };

  try {
    var over = global.ApnaShiftCallbackPopupConfig;
    if (over && typeof over === "object") {
      for (var ck in over) {
        if (Object.prototype.hasOwnProperty.call(over, ck)) CFG[ck] = over[ck];
      }
    }
  } catch (e) {
    /* config parse fail = defaults */
  }

  /* ---------- storage (fail-soft, private-mode safe) ---------- */

  function ls() {
    try {
      return global.localStorage || null;
    } catch (e) {
      return null;
    }
  }

  function ss() {
    try {
      return global.sessionStorage || null;
    } catch (e) {
      return null;
    }
  }

  function readState() {
    try {
      var s = ls();
      if (!s) return null;
      var raw = s.getItem(STORAGE_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || typeof o !== "object") return null;
      return { s: String(o.s || ""), t: Number(o.t) || 0 };
    } catch (e) {
      return null;
    }
  }

  function writeState(status) {
    try {
      var s = ls();
      if (s) {
        s.setItem(STORAGE_KEY, JSON.stringify({ s: status, t: Date.now() }));
        return;
      }
    } catch (e) {
      /* fall through: session fallback */
    }
    try {
      var s2 = ss();
      if (s2) s2.setItem(SESSION_KEY, "1");
    } catch (e2) {
      /* storage hi nahi — is session me ek hi baar via in-memory flag */
      memSeen = true;
    }
  }

  function sessionSeen() {
    if (memSeen) return true;
    try {
      var s = ss();
      return !!(s && s.getItem(SESSION_KEY));
    } catch (e) {
      return false;
    }
  }

  /* Guest = koi bhi auth token nahi (user/driver/admin) — "new customer". */
  function isGuest() {
    try {
      var s = ls(),
        s2 = ss();
      var has = function (k) {
        return !!((s && s.getItem(k)) || (s2 && s2.getItem(k)));
      };
      return !(
        has("apnashift_user_token") ||
        has("apnashift_driver_token") ||
        has("apnashift_admin_token")
      );
    } catch (e) {
      return true;
    }
  }

  var memSeen = false;

  /* Configured first-visit policy: pehli baar dikh chuka/dismiss/submitted
   * ho to dobara sirf tab jab reshowAfterDays > 0 aur utne din beet gaye. */
  function shouldShow() {
    if (!CFG.enabled) return false;
    if (CFG.guestsOnly && !isGuest()) return false;
    var st = readState();
    if (!st) {
      /* Koi state nahi = genuinely new visitor. Session marker tabhi banta
       * hai jab localStorage write fail ho (private mode / quota) — us case
       * me refresh ke baad dobara tang nahi karna. */
      return !sessionSeen();
    }
    if (st.s === "submitted") return false;
    var days = Number(CFG.reshowAfterDays) || 0;
    if (days <= 0) return false;
    return Date.now() - st.t >= days * DAY_MS;
  }

  /* ---------- DOM ---------- */

  var BACKDROP_ID = "apnashift-callback-popup";
  var backdrop = null,
    card = null,
    form = null,
    done = null,
    errEls = {},
    fields = {};
  var opened = false,
    submitted = false,
    prevOverflow = "",
    escHandler = null;

  var CSS =
    ".cbp-backdrop{position:fixed;inset:0;z-index:2000;display:flex;align-items:center;" +
    "justify-content:center;padding:20px;background:rgba(16,16,19,.9);font-family:" +
    '"Inter","Noto Sans Devanagari",system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}' +
    ".cbp-backdrop[hidden]{display:none}" +
    ".cbp-card{position:relative;background:#fff;color:#0b1f3a;border-radius:16px;" +
    "width:100%;max-width:580px;max-height:calc(100vh - 40px);max-height:calc(100dvh - 40px);" +
    "overflow-y:auto;overscroll-behavior:contain;padding:34px 30px 30px;" +
    "box-shadow:0 24px 70px rgba(0,0,0,.45);-webkit-overflow-scrolling:touch}" +
    ".cbp-close{position:absolute;top:12px;right:12px;width:42px;height:42px;padding:0;" +
    "border:0;border-radius:10px;background:transparent;color:#64748b;cursor:pointer;" +
    "font-size:26px;line-height:1;display:flex;align-items:center;justify-content:center}" +
    ".cbp-card .cbp-close:hover{background:#f1f5f9;color:#334155}" +
    ".cbp-card .cbp-title{margin:4px 0 0;text-align:center;font-family:" +
    '"Plus Jakarta Sans","Inter",system-ui,sans-serif;font-size:32px;font-weight:800;' +
    "letter-spacing:-.6px;color:#0b1f3a}" +
    ".cbp-card .cbp-sub{margin:16px auto 0;max-width:470px;text-align:center;color:#64748b;" +
    "font-size:17.5px;line-height:1.5}" +
    ".cbp-form{margin-top:30px}" +
    ".cbp-row{margin-bottom:14px}" +
    ".cbp-row:last-of-type{margin-bottom:0}" +
    ".cbp-card .cbp-field{display:block;width:100%;box-sizing:border-box;height:58px;" +
    "padding:0 20px;border:1.5px solid #dbe4f0;border-radius:10px;background:#fff;" +
    "color:#0b1f3a;font-family:" +
    '"Inter","Noto Sans Devanagari",system-ui,sans-serif;font-size:18px;outline:none}' +
    ".cbp-card .cbp-field::placeholder{color:#64748b;opacity:1}" +
    ".cbp-card .cbp-field:focus,.cbp-card .cbp-field.cbp-active{border-color:#ff6b00}" +
    ".cbp-card .cbp-field:focus{box-shadow:0 0 0 3px rgba(255,107,0,.16)}" +
    /* Page ki global :focus-visible navy ring ko input par mat lagne do —
     * reference design me focused field sirf orange border + halka glow. */
    ".cbp-card .cbp-field:focus-visible{outline:none}" +
    ".cbp-card .cbp-field.cbp-invalid{border-color:#dc2626;box-shadow:none}" +
    ".cbp-card .cbp-field.cbp-invalid:focus{box-shadow:0 0 0 3px rgba(220,38,38,.14)}" +
    ".cbp-err{margin-top:6px;color:#dc2626;font-size:13.5px;line-height:1.35}" +
    ".cbp-err[hidden]{display:none}" +
    ".cbp-card .cbp-submit{display:block;width:100%;margin-top:20px;height:54px;border:0;" +
    "border-radius:10px;background:#ff6b00;color:#fff;cursor:pointer;font-family:" +
    '"Plus Jakarta Sans","Inter",system-ui,sans-serif;font-size:20px;font-weight:800;' +
    "letter-spacing:-.2px;transition:background .15s ease}" +
    ".cbp-card .cbp-submit:hover{background:#f26200}" +
    ".cbp-card .cbp-submit:active{background:#e35b00}" +
    ".cbp-card .cbp-submit:focus-visible{outline:3px solid #0a2340;outline-offset:2px}" +
    ".cbp-done{margin-top:30px;text-align:center}" +
    ".cbp-check{width:66px;height:66px;margin:0 auto;border-radius:50%;background:#12a150;" +
    "color:#fff;font-size:34px;font-weight:800;display:flex;align-items:center;" +
    "justify-content:center}" +
    ".cbp-card .cbp-done-title{margin:18px 0 0;font-family:" +
    '"Plus Jakarta Sans","Inter",system-ui,sans-serif;font-size:26px;font-weight:800;' +
    "color:#0b1f3a}" +
    ".cbp-card .cbp-done-sub{margin:10px auto 0;max-width:420px;color:#64748b;font-size:16.5px;" +
    "line-height:1.5}" +
    ".cbp-card .cbp-wa{display:inline-block;margin-top:18px;padding:13px 22px;border:1.5px solid " +
    "#dbe4f0;border-radius:10px;background:#fff;color:#0b1f3a;cursor:pointer;font-family:" +
    '"Inter",system-ui,sans-serif;font-size:15.5px;font-weight:700}' +
    ".cbp-card .cbp-wa:hover{border-color:#ff6b00;color:#e35b00}" +
    ".cbp-card .cbp-legal{margin-top:16px;text-align:center;color:#94a3b8;font-size:12.5px}" +
    "@media (max-width:560px){" +
    ".cbp-backdrop{padding:14px}" +
    ".cbp-card{padding:30px 18px 22px;border-radius:14px}" +
    ".cbp-close{top:6px;right:6px;width:38px;height:38px;font-size:23px}" +
    ".cbp-card .cbp-title{font-size:26px;margin-top:6px}" +
    ".cbp-card .cbp-sub{font-size:15.5px;margin-top:12px}" +
    ".cbp-form{margin-top:22px}" +
    ".cbp-row{margin-bottom:12px}" +
    ".cbp-card .cbp-field{height:54px;font-size:16.5px;padding:0 16px}" +
    ".cbp-card .cbp-submit{height:52px;font-size:18px;margin-top:16px}" +
    ".cbp-card .cbp-done-title{font-size:22px}" +
    ".cbp-card .cbp-done-sub{font-size:15.5px}}";

  function el(id) {
    return document.getElementById(id);
  }

  function build() {
    if (backdrop && document.body.contains(backdrop)) return;

    var style = document.getElementById("apnashift-callback-popup-css");
    if (!style) {
      style = document.createElement("style");
      style.id = "apnashift-callback-popup-css";
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    var host = document.createElement("div");
    host.className = "cbp-backdrop";
    host.id = BACKDROP_ID;
    host.hidden = true;
    /* Static template — koi server/user string interpolation nahi (XSS-safe). */
    host.innerHTML =
      '<div class="cbp-card" role="dialog" aria-modal="true" aria-labelledby="cbp-title"' +
      ' aria-describedby="cbp-desc">' +
      '<button type="button" class="cbp-close" aria-label="Close">&times;</button>' +
      '<h2 class="cbp-title" id="cbp-title">Moving Soon?</h2>' +
      '<p class="cbp-sub" id="cbp-desc">Let us help! Get a free, no-obligation callback from our' +
      " ApnaShift App moving experts.</p>" +
      '<form class="cbp-form" novalidate autocomplete="on">' +
      '<div class="cbp-row"><input class="cbp-field cbp-active" id="cbp-from" name="fromCity"' +
      ' type="text" placeholder="From City" autocomplete="address-level2" maxlength="60"' +
      ' aria-label="From City">' +
      '<div class="cbp-err" id="cbp-err-from" hidden></div></div>' +
      '<div class="cbp-row"><input class="cbp-field" id="cbp-to" name="toCity" type="text"' +
      ' placeholder="To City" autocomplete="off" maxlength="60" aria-label="To City">' +
      '<div class="cbp-err" id="cbp-err-to" hidden></div></div>' +
      '<div class="cbp-row"><input class="cbp-field" id="cbp-name" name="name" type="text"' +
      ' placeholder="Your Name" autocomplete="name" maxlength="60" aria-label="Your Name">' +
      '<div class="cbp-err" id="cbp-err-name" hidden></div></div>' +
      '<div class="cbp-row"><input class="cbp-field" id="cbp-phone" name="phone" type="tel"' +
      ' placeholder="Phone Number*" autocomplete="tel" inputmode="tel" maxlength="16"' +
      ' aria-label="Phone Number (required)">' +
      '<div class="cbp-err" id="cbp-err-phone" hidden></div></div>' +
      '<button type="submit" class="cbp-submit">Get a Callback</button>' +
      "</form>" +
      '<div class="cbp-done" hidden>' +
      '<div class="cbp-check" aria-hidden="true">&#10003;</div>' +
      '<h3 class="cbp-done-title">Thank you!</h3>' +
      '<p class="cbp-done-sub">Our ApnaShift moving expert will call you back shortly.' +
      " Your details are ready on WhatsApp \u2014 press Send there to confirm.</p>" +
      '<button type="button" class="cbp-wa">Open WhatsApp</button>' +
      "</div>" +
      "</div>";
    document.body.appendChild(host);

    backdrop = host;
    card = host.querySelector(".cbp-card");
    form = host.querySelector(".cbp-form");
    done = host.querySelector(".cbp-done");
    fields = {
      from: el("cbp-from"),
      to: el("cbp-to"),
      name: el("cbp-name"),
      phone: el("cbp-phone")
    };
    errEls = {
      from: el("cbp-err-from"),
      to: el("cbp-err-to"),
      name: el("cbp-err-name"),
      phone: el("cbp-err-phone")
    };

    wire();
  }

  function clearErr(key) {
    var f = fields[key],
      e = errEls[key];
    if (!f || !e) return;
    f.classList.remove("cbp-invalid");
    f.removeAttribute("aria-invalid");
    e.hidden = true;
    e.textContent = "";
  }

  function setErr(key, msg) {
    var f = fields[key],
      e = errEls[key];
    if (!f || !e) return false;
    if (!msg) {
      clearErr(key);
      return true;
    }
    f.classList.add("cbp-invalid");
    f.setAttribute("aria-invalid", "true");
    e.textContent = msg;
    e.hidden = false;
    return false;
  }

  function setActive(f) {
    if (!f) return;
    var all = card.querySelectorAll(".cbp-field");
    for (var i = 0; i < all.length; i++) all[i].classList.remove("cbp-active");
    f.classList.add("cbp-active");
  }

  function cleanPhone(v) {
    var p = String(v || "").replace(/[\s\-().]/g, "");
    if (p.indexOf("+91") === 0) p = p.substring(3);
    else if (p.length === 12 && p.indexOf("91") === 0) p = p.substring(2);
    else if (p.length === 11 && p.charAt(0) === "0") p = p.substring(1);
    return p;
  }

  function validate() {
    var from = String(fields.from.value || "").trim();
    var to = String(fields.to.value || "").trim();
    var name = String(fields.name.value || "").trim();
    var phone = cleanPhone(fields.phone.value);
    var firstBad = null;

    if (!setErr("from", from.length < 2 ? "From city is required." : null)) {
      firstBad = firstBad || fields.from;
    }
    if (!setErr("to", to.length < 2 ? "To city is required." : null)) {
      firstBad = firstBad || fields.to;
    }
    if (!setErr("name", name.length < 2 ? "Please enter your name." : null)) {
      firstBad = firstBad || fields.name;
    }
    var phoneMsg = null;
    if (!phone) phoneMsg = "Phone number is required.";
    else if (!PHONE_RE.test(phone)) {
      phoneMsg = "Enter a valid 10-digit Indian mobile number (starts with 6-9).";
    }
    if (!setErr("phone", phoneMsg)) firstBad = firstBad || fields.phone;

    if (firstBad) {
      setActive(firstBad);
      try {
        firstBad.focus();
      } catch (e) {
        /* ignore */
      }
      return null;
    }
    return { from: from, to: to, name: name, phone: phone };
  }

  function waUrl(data) {
    var msg =
      "ApnaShift callback request (Moving Soon?)\n" +
      "From City: " + data.from + "\n" +
      "To City: " + data.to + "\n" +
      "Name: " + data.name + "\n" +
      "Phone: " + data.phone;
    return "https://wa.me/" + CFG.whatsapp + "?text=" + encodeURIComponent(msg);
  }

  function openWhatsApp(data) {
    try {
      global.open(waUrl(data), "_blank", "noopener");
    } catch (e) {
      /* popup blocked — "Open WhatsApp" button fallback maujood hai */
    }
  }

  function wire() {
    var keys = ["from", "to", "name", "phone"];
    var i;
    for (i = 0; i < keys.length; i++) {
      (function (key) {
        var f = fields[key];
        if (!f) return;
        f.addEventListener("focus", function () {
          setActive(f);
        });
        f.addEventListener("input", function () {
          clearErr(key);
        });
      })(keys[i]);
    }

    /* Indian mobile: sirf digit/+91 allow (paste bhi yahi clean karta hai) */
    fields.phone.addEventListener("input", function () {
      var v = fields.phone.value;
      if (!/^[+0-9\s\-().]*$/.test(v)) {
        fields.phone.value = v.replace(/[^+0-9\s\-().]/g, "");
      }
    });

    card.querySelector(".cbp-close").addEventListener("click", function () {
      close();
    });

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var data = validate();
      if (!data) return;
      submitted = true;
      writeState("submitted");
      form.hidden = true;
      var sub = card.querySelector(".cbp-sub");
      if (sub) sub.hidden = true;
      done.hidden = false;
      openWhatsApp(data);
      var waBtn = card.querySelector(".cbp-wa");
      if (waBtn) {
        waBtn.onclick = function () {
          openWhatsApp(data);
        };
      }
      try {
        done.scrollIntoView({ block: "nearest" });
      } catch (e) {
        /* ignore */
      }
    });

    backdrop.addEventListener("click", function (ev) {
      if (ev.target === backdrop) close();
    });
  }

  /* ---------- open / close ---------- */

  function open() {
    if (opened) return;
    build();
    if (opened) return;
    opened = true;
    writeState("shown");
    prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    backdrop.hidden = false;

    escHandler = function (ev) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        close();
      }
    };
    document.addEventListener("keydown", escHandler);

    /* Reference design: pehle field ka orange focus. Touch par keyboard
     * modal ko dhak deta hai — sirf fine pointer (desktop) par autofocus. */
    try {
      if (global.matchMedia && global.matchMedia("(pointer: fine)").matches) {
        fields.from.focus();
      }
    } catch (e) {
      /* ignore */
    }
  }

  function close() {
    if (!opened) return;
    opened = false;
    document.body.style.overflow = prevOverflow;
    if (escHandler) {
      document.removeEventListener("keydown", escHandler);
      escHandler = null;
    }
    if (backdrop) backdrop.hidden = true;
    if (!submitted) writeState("dismissed");
  }

  /* ---------- schedule (auto, koi click nahi) ---------- */

  function schedule() {
    if (!CFG.enabled) return;
    if (!shouldShow()) return;
    global.setTimeout(function () {
      /* Fire par dobara policy check (dusri tab me state write ho sakti hai). */
      try {
        if (shouldShow()) open();
      } catch (e) {
        /* chup — page par kabhi throw nahi */
      }
    }, Math.max(0, Number(CFG.showDelayMs) || 0));
  }

  function reset() {
    try {
      var s = ls();
      if (s) s.removeItem(STORAGE_KEY);
      var s2 = ss();
      if (s2) s2.removeItem(SESSION_KEY);
    } catch (e) {
      /* ignore */
    }
    memSeen = false;
    close();
  }

  global.ApnaShiftCallbackPopup = {
    open: open,
    close: close,
    shouldShow: shouldShow,
    reset: reset
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", schedule);
  } else {
    schedule();
  }
})(typeof window !== "undefined" ? window : this);
