/* ApnaShift shared language module (English / हिन्दी).
 * Browser globals (window/document/localStorage) are expected here —
 * eslint node env does not know them (see globals comment below).
 * Handles the site header + nav on every page, injects the 🌐 language
 * dropdown if missing, and translates any [data-i18n] / [data-i18n-ph] /
 * [data-i18n-aria] elements using SHARED + window.PAGE_I18N dictionaries.
 * Pages define: window.PAGE_I18N = { en:{...}, hi:{...} } BEFORE this file.
 * Choice persists in localStorage ("apnashift-lang") across pages.
 * Do NOT edit per-page HTML for the header — this file owns it.
 */
/* global window, document */
(function () {
  "use strict";

  var SHARED = {
    en: {
      nav_home: "Home",
      nav_book: "Book",
      nav_login: "Login",
      nav_driver: "Driver",
      nav_join: "Join as Driver",
      nav_driver_login: "Driver Login",
      nav_enterprise: "Enterprise",
      nav_help: "Help",
      nav_dashboard: "Dashboard",
      nav_mybookings: "My Bookings",
      nav_payments: "Payments",
      lang_en: "English",
      lang_hi: "हिन्दी"
    },
    hi: {
      nav_home: "होम",
      nav_book: "बुक करें",
      nav_login: "लॉगिन",
      nav_driver: "ड्राइवर",
      nav_join: "ड्राइवर बनें",
      nav_driver_login: "ड्राइवर लॉगिन",
      nav_enterprise: "एंटरप्राइज़",
      nav_help: "सहायता",
      nav_dashboard: "डैशबोर्ड",
      nav_mybookings: "मेरी बुकिंग",
      nav_payments: "भुगतान",
      lang_en: "English",
      lang_hi: "हिन्दी"
    }
  };

  // Header nav links mapped by file name (only inside nav.site-nav).
  var NAV_BY_HREF = {
    "index.html": "nav_home",
    "booking.html": "nav_book",
    "create-booking.html": "nav_book",
    "user-auth.html": "nav_login",
    "enterprise.html": "nav_enterprise",
    "help.html": "nav_help",
    "driver-register.html": "nav_join",
    "driver-login.html": "nav_driver_login",
    "customer-dashboard.html": "nav_mybookings",
    "my-bookings.html": "nav_mybookings",
    "admin-dashboard.html": "nav_dashboard",
    "payment-status.html": "nav_payments"
  };

  function pageDict(lang) {
    try {
      if (window.PAGE_I18N && window.PAGE_I18N[lang]) return window.PAGE_I18N[lang];
    } catch (e) { /* private mode — fall through to {} */ }
    return {};
  }

  function merged(lang) {
    var out = {};
    var s = SHARED[lang] || SHARED.en;
    var k;
    for (k in s) { if (Object.prototype.hasOwnProperty.call(s, k)) out[k] = s[k]; }
    var p = pageDict(lang);
    for (k in p) { if (Object.prototype.hasOwnProperty.call(p, k)) out[k] = p[k]; }
    return out;
  }

  function currentLang() {
    try {
      var l = localStorage.getItem("apnashift-lang");
      if (l === "hi" || l === "en") return l;
    } catch (e) { /* private mode — default to en */ }
    return "en";
  }

  function applyLang(lang) {
    if (lang !== "hi" && lang !== "en") lang = "en";
    var dict = merged(lang);
    try { localStorage.setItem("apnashift-lang", lang); } catch (e) { /* private mode — skip persist */ }
    document.documentElement.lang = (lang === "hi") ? "hi" : "en";
    if (dict.page_title) document.title = dict.page_title;
    var meta = document.querySelector('meta[name="description"]');
    if (meta && dict.meta_desc) meta.setAttribute("content", dict.meta_desc);
    var els = document.querySelectorAll("[data-i18n]");
    for (var i = 0; i < els.length; i++) {
      var key = els[i].getAttribute("data-i18n");
      if (key && dict[key] !== undefined) els[i].textContent = dict[key];
    }
    var phs = document.querySelectorAll("[data-i18n-ph]");
    for (var j = 0; j < phs.length; j++) {
      var pk = phs[j].getAttribute("data-i18n-ph");
      if (pk && dict[pk] !== undefined) phs[j].setAttribute("placeholder", dict[pk]);
    }
    var ars = document.querySelectorAll("[data-i18n-aria]");
    for (var m = 0; m < ars.length; m++) {
      var ak = ars[m].getAttribute("data-i18n-aria");
      if (ak && dict[ak] !== undefined) ars[m].setAttribute("aria-label", dict[ak]);
    }
    var label = document.getElementById("langLabel");
    if (label) label.textContent = (lang === "hi") ? "हिन्दी" : "English";
    var btns = document.querySelectorAll("[data-setlang]");
    for (var b = 0; b < btns.length; b++) {
      btns[b].classList.toggle("active", btns[b].getAttribute("data-setlang") === lang);
    }
    var drop = document.getElementById("langDrop");
    if (drop) drop.removeAttribute("open");
  }

  function ensureFont() {
    var links = document.querySelectorAll('link[href*="fonts.googleapis.com"]');
    for (var i = 0; i < links.length; i++) {
      if ((links[i].getAttribute("href") || "").indexOf("Devanagari") !== -1) return;
    }
    var l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=Noto+Sans+Devanagari:wght@500;600;700;800&display=swap";
    document.head.appendChild(l);
  }

  function ensureCss() {
    if (document.getElementById("apnashift-lang-css")) return;
    var css = ".header-actions{display:flex;gap:10px;align-items:center;margin-left:auto;flex:0 0 auto}"
      + ".lang-drop{position:relative}"
      + ".lang-drop summary{list-style:none;cursor:pointer;display:inline-flex;align-items:center;gap:8px;color:#fff;font-weight:600;font-size:.9rem;padding:8px 16px;border-radius:10px;background:rgba(255,255,255,.03);border:1.2px solid rgba(255,255,255,.28);white-space:nowrap}"
      + ".lang-drop summary::-webkit-details-marker{display:none}"
      + ".lang-menu{position:absolute;top:calc(100% + 8px);right:0;background:#102e57;border:1px solid #24406b;border-radius:12px;padding:6px;min-width:180px;box-shadow:0 12px 30px rgba(0,0,0,.35);z-index:70}"
      + ".lang-menu button{display:flex;width:100%;align-items:center;gap:8px;background:transparent;border:0;color:#fff;font:inherit;font-weight:600;font-size:.88rem;padding:10px 12px;border-radius:8px;cursor:pointer;text-align:left}"
      + ".lang-menu button:hover{background:rgba(255,255,255,.12)}"
      + ".lang-menu button.active{background:rgba(255,178,0,.15)}"
      + ".lang-menu .tick{margin-left:auto;color:#ffb200;font-weight:800;visibility:hidden}"
      + ".lang-menu button.active .tick{visibility:visible}"
      + 'html[lang="hi"] body,html[lang="hi"] button,html[lang="hi"] input,html[lang="hi"] select,html[lang="hi"] textarea,html[lang="hi"] h1,html[lang="hi"] h2,html[lang="hi"] h3{font-family:"Noto Sans Devanagari","Inter",system-ui,sans-serif}'
      + "@media(max-width:640px){.lang-drop summary{padding:7px 10px;font-size:.82rem}}";
    var st = document.createElement("style");
    st.id = "apnashift-lang-css";
    st.textContent = css;
    document.head.appendChild(st);
  }

  function ensureDropdown() {
    if (document.getElementById("langDrop")) return;
    var inner = document.querySelector(".site-header-inner");
    if (!inner) return;
    var wrap = document.createElement("div");
    wrap.className = "header-actions";
    wrap.innerHTML = '<details class="lang-drop" id="langDrop"><summary aria-label="Language">🌐&nbsp; <span id="langLabel">English</span>&nbsp; ▾</summary><div class="lang-menu"><button type="button" data-setlang="en"><span>English</span><span class="tick">✓</span></button><button type="button" data-setlang="hi"><span>हिन्दी</span><span class="tick">✓</span></button></div></details>';
    var menuBtn = document.getElementById("navMenuBtn");
    if (menuBtn && menuBtn.parentNode === inner) inner.insertBefore(wrap, menuBtn);
    else inner.appendChild(wrap);
  }

  function autotagNav() {
    var links = document.querySelectorAll("nav.site-nav a[href]");
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      if (a.hasAttribute("data-i18n")) continue;
      var href = (a.getAttribute("href") || "").split("?")[0].split("#")[0];
      var base = href.substring(href.lastIndexOf("/") + 1);
      if (NAV_BY_HREF[base]) a.setAttribute("data-i18n", NAV_BY_HREF[base]);
    }
    var sums = document.querySelectorAll("nav.site-nav details.nav-drop summary");
    for (var j = 0; j < sums.length; j++) {
      var s = sums[j];
      if (!s.hasAttribute("data-i18n") && s.textContent.trim() === "Driver") {
        s.setAttribute("data-i18n", "nav_driver");
      }
    }
  }

  function wire() {
    var btns = document.querySelectorAll("[data-setlang]");
    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        if (b.__langWired) return;
        b.__langWired = true;
        b.addEventListener("click", function (ev) {
          ev.preventDefault();
          applyLang(b.getAttribute("data-setlang"));
        });
      })(btns[i]);
    }
  }

  function init() {
    ensureFont();
    ensureCss();
    ensureDropdown();
    autotagNav();
    wire();
    applyLang(currentLang());
  }

  window.ApnaShiftLang = { set: applyLang, get: currentLang };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
