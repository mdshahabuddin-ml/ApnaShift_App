/* ApnaShift shared language module (10 languages).
 * Browser globals (window/document/localStorage) are expected here —
 * eslint node env does not know them (see globals comment below).
 * Handles the site header + nav on every page, injects the 🌐 language
 * dropdown if missing, and translates any [data-i18n] / [data-i18n-ph] /
 * [data-i18n-aria] elements using SHARED + window.PAGE_I18N dictionaries.
 * Pages define: window.PAGE_I18N = { en:{...}, hi:{...}, ... } BEFORE this file.
 * Any language missing a key safely falls back to English (never shows
 * undefined/null/raw keys). Urdu uses dir="rtl", all others dir="ltr".
 * Choice persists in localStorage ("apnashift-lang") across pages.
 * Do NOT edit per-page HTML for the header — this file owns it.
 */
/* global window, document */
(function () {
  "use strict";

  // Exactly 10 supported locales, native-script names, UTF-8 throughout.
  var LANGS = [
    { code: "en", name: "English", dir: "ltr" },
    { code: "hi", name: "हिन्दी", dir: "ltr" },
    { code: "bn", name: "বাংলা", dir: "ltr" },
    { code: "mr", name: "मराठी", dir: "ltr" },
    { code: "te", name: "తెలుగు", dir: "ltr" },
    { code: "ta", name: "தமிழ்", dir: "ltr" },
    { code: "gu", name: "ગુજરાતી", dir: "ltr" },
    { code: "ur", name: "اردو", dir: "rtl" },
    { code: "kn", name: "ಕನ್ನಡ", dir: "ltr" },
    { code: "or", name: "ଓଡ଼ିଆ", dir: "ltr" }
  ];

  function langDir(code) {
    for (var i = 0; i < LANGS.length; i++) {
      if (LANGS[i].code === code) return LANGS[i].dir;
    }
    return "ltr";
  }

  function langName(code) {
    for (var i = 0; i < LANGS.length; i++) {
      if (LANGS[i].code === code) return LANGS[i].name;
    }
    return "English";
  }

  function isSupported(code) {
    return langName(code) !== "English" || code === "en";
  }

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
    },
    bn: {
      nav_home: "হোম",
      nav_book: "বুক করুন",
      nav_login: "লগইন",
      nav_driver: "ড্রাইভার",
      nav_join: "ড্রাইভার হোন",
      nav_driver_login: "ড্রাইভার লগইন",
      nav_enterprise: "এন্টারপ্রাইজ",
      nav_help: "সাহায্য",
      nav_dashboard: "ড্যাশবোর্ড",
      nav_mybookings: "আমার বুকিং",
      nav_payments: "পেমেন্ট",
      lang_en: "English",
      lang_hi: "हिन्दी"
    },
    mr: {
      nav_home: "होम",
      nav_book: "बुक करा",
      nav_login: "लॉगिन",
      nav_driver: "ड्रायव्हर",
      nav_join: "ड्रायव्हर बना",
      nav_driver_login: "ड्रायव्हर लॉगिन",
      nav_enterprise: "एंटरप्राइझ",
      nav_help: "मदत",
      nav_dashboard: "डॅशबोर्ड",
      nav_mybookings: "माझी बुकिंग",
      nav_payments: "पेमेंट",
      lang_en: "English",
      lang_hi: "हिन्दी"
    },
    te: {
      nav_home: "హోమ్",
      nav_book: "బుక్ చేయండి",
      nav_login: "లాగిన్",
      nav_driver: "డ్రైవర్",
      nav_join: "డ్రైవర్‌గా చేరండి",
      nav_driver_login: "డ్రైవర్ లాగిన్",
      nav_enterprise: "ఎంటర్‌ప్రైజ్",
      nav_help: "సహాయం",
      nav_dashboard: "డాష్‌బోర్డ్",
      nav_mybookings: "నా బుకింగ్‌లు",
      nav_payments: "చెల్లింపులు",
      lang_en: "English",
      lang_hi: "हिन्दी"
    },
    ta: {
      nav_home: "முகப்பு",
      nav_book: "முன்பதிவு",
      nav_login: "உள்நுழை",
      nav_driver: "ஓட்டுநர்",
      nav_join: "ஓட்டுநராக சேரவும்",
      nav_driver_login: "ஓட்டுநர் உள்நுழைவு",
      nav_enterprise: "நிறுவனம்",
      nav_help: "உதவி",
      nav_dashboard: "டாஷ்போர்டு",
      nav_mybookings: "எனது முன்பதிவுகள்",
      nav_payments: "கட்டணங்கள்",
      lang_en: "English",
      lang_hi: "हिन्दी"
    },
    gu: {
      nav_home: "હોમ",
      nav_book: "બુક કરો",
      nav_login: "લૉગિન",
      nav_driver: "ડ્રાઇવર",
      nav_join: "ડ્રાઇવર બનો",
      nav_driver_login: "ડ્રાઇવર લૉગિન",
      nav_enterprise: "એન્ટરપ્રાઇઝ",
      nav_help: "મદદ",
      nav_dashboard: "ડેશબોર્ડ",
      nav_mybookings: "મારી બુકિંગ",
      nav_payments: "ચુકવણી",
      lang_en: "English",
      lang_hi: "हिन्दी"
    },
    ur: {
      nav_home: "ہوم",
      nav_book: "بک کریں",
      nav_login: "لاگ اِن",
      nav_driver: "ڈرائیور",
      nav_join: "ڈرائیور بنیں",
      nav_driver_login: "ڈرائیور لاگ اِن",
      nav_enterprise: "انٹرپرائز",
      nav_help: "مدد",
      nav_dashboard: "ڈیش بورڈ",
      nav_mybookings: "میری بکنگ",
      nav_payments: "ادائیگی",
      lang_en: "English",
      lang_hi: "हिन्दी"
    },
    kn: {
      nav_home: "ಮುಖಪುಟ",
      nav_book: "ಬುಕ್ ಮಾಡಿ",
      nav_login: "ಲಾಗಿನ್",
      nav_driver: "ಚಾಲಕ",
      nav_join: "ಚಾಲಕರಾಗಿ ಸೇರಿ",
      nav_driver_login: "ಚಾಲಕ ಲಾಗಿನ್",
      nav_enterprise: "ಎಂಟರ್‌ಪ್ರೈಸ್",
      nav_help: "ಸಹಾಯ",
      nav_dashboard: "ಡ್ಯಾಶ್‌ಬೋರ್ಡ್",
      nav_mybookings: "ನನ್ನ ಬುಕಿಂಗ್‌ಗಳು",
      nav_payments: "ಪಾವತಿಗಳು",
      lang_en: "English",
      lang_hi: "हिन्दी"
    },
    or: {
      nav_home: "ହୋମ୍",
      nav_book: "ବୁକ୍ କରନ୍ତୁ",
      nav_login: "ଲଗଇନ୍",
      nav_driver: "ଡ୍ରାଇଭର",
      nav_join: "ଡ୍ରାଇଭର ହୁଅନ୍ତୁ",
      nav_driver_login: "ଡ୍ରାଇଭର ଲଗଇନ୍",
      nav_enterprise: "ଏଣ୍ଟରପ୍ରାଇଜ୍",
      nav_help: "ସହାୟତା",
      nav_dashboard: "ଡ୍ୟାସବୋର୍ଡ",
      nav_mybookings: "ମୋ ବୁକିଂ",
      nav_payments: "ପେମେଣ୍ଟ",
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

  // Safe lookup with English fallback — never returns undefined/null/raw keys.
  function t(key, lang) {
    var pd = pageDict(lang);
    if (pd && pd[key] !== undefined && pd[key] !== null) return pd[key];
    var sd = SHARED[lang];
    if (sd && sd[key] !== undefined && sd[key] !== null) return sd[key];
    pd = pageDict("en");
    if (pd && pd[key] !== undefined && pd[key] !== null) return pd[key];
    if (SHARED.en[key] !== undefined && SHARED.en[key] !== null) return SHARED.en[key];
    return "";
  }

  function merged(lang) {
    var out = {};
    var s = SHARED.en;
    var k;
    for (k in s) { if (Object.prototype.hasOwnProperty.call(s, k)) out[k] = s[k]; }
    var p = pageDict("en");
    for (k in p) { if (Object.prototype.hasOwnProperty.call(p, k)) out[k] = p[k]; }
    if (lang !== "en") {
      var sl = SHARED[lang] || {};
      for (k in sl) { if (Object.prototype.hasOwnProperty.call(sl, k)) out[k] = sl[k]; }
      var pl = pageDict(lang);
      for (k in pl) { if (Object.prototype.hasOwnProperty.call(pl, k)) out[k] = pl[k]; }
    }
    return out;
  }

  // Priority: saved preference > browser exact match > English default.
  function currentLang() {
    try {
      var l = localStorage.getItem("apnashift-lang");
      if (l && isSupported(l)) return l;
    } catch (e) { /* private mode — continue to browser/default */ }
    try {
      var b = (navigator.language || navigator.userLanguage || "en").toLowerCase();
      var short = b.split("-")[0].split("_")[0];
      if (isSupported(short)) return short;
    } catch (e2) { /* fall through to default */ }
    return "en";
  }

  function applyLang(lang) {
    if (!isSupported(lang)) lang = "en";
    var dict = merged(lang);
    try { localStorage.setItem("apnashift-lang", lang); } catch (e) { /* private mode — skip persist */ }
    document.documentElement.lang = lang;
    document.documentElement.dir = langDir(lang);
    if (dict.page_title) document.title = dict.page_title;
    var meta = document.querySelector('meta[name="description"]');
    if (meta && dict.meta_desc) meta.setAttribute("content", dict.meta_desc);
    var els = document.querySelectorAll("[data-i18n]");
    for (var i = 0; i < els.length; i++) {
      var key = els[i].getAttribute("data-i18n");
      if (key) {
        var v = t(key, lang);
        if (v !== "") els[i].textContent = v;
      }
    }
    var phs = document.querySelectorAll("[data-i18n-ph]");
    for (var j = 0; j < phs.length; j++) {
      var pk = phs[j].getAttribute("data-i18n-ph");
      if (pk) {
        var pv = t(pk, lang);
        if (pv !== "") phs[j].setAttribute("placeholder", pv);
      }
    }
    var ars = document.querySelectorAll("[data-i18n-aria]");
    for (var m = 0; m < ars.length; m++) {
      var ak = ars[m].getAttribute("data-i18n-aria");
      if (ak) {
        var av = t(ak, lang);
        if (av !== "") ars[m].setAttribute("aria-label", av);
      }
    }
    var label = document.getElementById("langLabel");
    if (label) label.textContent = langName(lang);
    var btns = document.querySelectorAll("[data-setlang]");
    for (var b = 0; b < btns.length; b++) {
      btns[b].classList.toggle("active", btns[b].getAttribute("data-setlang") === lang);
    }
    var drop = document.getElementById("langDrop");
    if (drop) drop.removeAttribute("open");
  }

  function ensureFont() {
    var links = document.querySelectorAll('link[href*="fonts.googleapis.com"]');
    var hasDev = false, hasMulti = false;
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute("href") || "";
      if (href.indexOf("Devanagari") !== -1) hasDev = true;
      if (href.indexOf("Noto+Sans+Bengali") !== -1) hasMulti = true;
    }
    if (!hasDev) {
      var l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = "https://fonts.googleapis.com/css2?family=Noto+Sans+Devanagari:wght@500;600;700;800&display=swap";
      document.head.appendChild(l);
    }
    if (!hasMulti) {
      // One request covering Bengali/Telugu/Tamil/Gujarati/Kannada/Odia/Urdu
      // scripts; pages keep working if it fails (system-font fallback).
      var l2 = document.createElement("link");
      l2.rel = "stylesheet";
      l2.href = "https://fonts.googleapis.com/css2?family=Noto+Sans+Bengali:wght@500;600;700&family=Noto+Sans+Telugu:wght@500;600;700&family=Noto+Sans+Tamil:wght@500;600;700&family=Noto+Sans+Gujarati:wght@500;600;700&family=Noto+Sans+Kannada:wght@500;600;700&family=Noto+Sans+Oriya:wght@500;600;700&family=Noto+Nastaliq+Urdu:wght@500;600;700&display=swap";
      document.head.appendChild(l2);
    }
  }

  function ensureCss() {
    if (document.getElementById("apnashift-lang-css")) return;
    var css = ".header-actions{display:flex;gap:10px;align-items:center;margin-left:auto;flex:0 0 auto}"
      + ".lang-drop{position:relative}"
      + ".lang-drop summary{list-style:none;cursor:pointer;display:inline-flex;align-items:center;gap:8px;color:#fff;font-weight:600;font-size:.9rem;padding:8px 16px;border-radius:10px;background:rgba(255,255,255,.03);border:1.2px solid rgba(255,255,255,.28);white-space:nowrap}"
      + ".lang-drop summary::-webkit-details-marker{display:none}"
      + ".lang-menu{position:absolute;top:calc(100% + 8px);right:0;background:#102e57;border:1px solid #24406b;border-radius:12px;padding:6px;min-width:200px;max-height:min(60vh,380px);overflow:auto;box-shadow:0 12px 30px rgba(0,0,0,.35);z-index:70}"
      + ".lang-menu button{display:flex;width:100%;align-items:center;gap:8px;background:transparent;border:0;color:#fff;font:inherit;font-weight:600;font-size:.88rem;padding:10px 12px;border-radius:8px;cursor:pointer;text-align:start}"
      + ".lang-menu button:hover{background:rgba(255,255,255,.12)}"
      + ".lang-menu button:focus-visible{outline:2px solid #ffb200;outline-offset:1px}"
      + ".lang-menu button.active{background:rgba(255,178,0,.15)}"
      + ".lang-menu .tick{margin-inline-start:auto;color:#ffb200;font-weight:800;visibility:hidden}"
      + ".lang-menu button.active .tick{visibility:visible}"
      + 'html[lang="hi"] body,html[lang="hi"] button,html[lang="hi"] input,html[lang="hi"] select,html[lang="hi"] textarea,html[lang="hi"] h1,html[lang="hi"] h2,html[lang="hi"] h3{font-family:"Noto Sans Devanagari","Inter",system-ui,sans-serif}'
      + 'html[lang="bn"] body,html[lang="bn"] button,html[lang="bn"] input,html[lang="bn"] select,html[lang="bn"] textarea{font-family:"Noto Sans Bengali","Noto Sans Devanagari",system-ui,sans-serif}'
      + 'html[lang="te"] body,html[lang="te"] button,html[lang="te"] input,html[lang="te"] select,html[lang="te"] textarea{font-family:"Noto Sans Telugu","Noto Sans Devanagari",system-ui,sans-serif}'
      + 'html[lang="ta"] body,html[lang="ta"] button,html[lang="ta"] input,html[lang="ta"] select,html[lang="ta"] textarea{font-family:"Noto Sans Tamil","Noto Sans Devanagari",system-ui,sans-serif}'
      + 'html[lang="gu"] body,html[lang="gu"] button,html[lang="gu"] input,html[lang="gu"] select,html[lang="gu"] textarea{font-family:"Noto Sans Gujarati","Noto Sans Devanagari",system-ui,sans-serif}'
      + 'html[lang="kn"] body,html[lang="kn"] button,html[lang="kn"] input,html[lang="kn"] select,html[lang="kn"] textarea{font-family:"Noto Sans Kannada","Noto Sans Devanagari",system-ui,sans-serif}'
      + 'html[lang="or"] body,html[lang="or"] button,html[lang="or"] input,html[lang="or"] select,html[lang="or"] textarea{font-family:"Noto Sans Oriya","Noto Sans Devanagari",system-ui,sans-serif}'
      + 'html[lang="ur"] body,html[lang="ur"] button,html[lang="ur"] input,html[lang="ur"] select,html[lang="ur"] textarea{font-family:"Noto Nastaliq Urdu","Noto Sans Devanagari",system-ui,sans-serif}'
      + 'html[dir="rtl"] .lang-menu{right:auto;left:0}'
      + 'html[dir="rtl"] input[type="tel"],html[dir="rtl"] input[type="number"],html[dir="rtl"] .ltr{direction:ltr;unicode-bidi:embed;text-align:start}';
    var st = document.createElement("style");
    st.id = "apnashift-lang-css";
    st.textContent = css;
    if (document.head) document.head.appendChild(st);
    else document.addEventListener("DOMContentLoaded", function () {
      if (!document.getElementById("apnashift-lang-css")) document.head.appendChild(st);
    });
  }

  function ensureDropdown() {
    var existing = document.getElementById("langDrop");
    if (existing) {
      // Legacy 2-language menu -> rebuild with all 10 (keeps same id/style).
      var menu = existing.querySelector(".lang-menu");
      if (menu && !menu.querySelector('[data-setlang="bn"]')) {
        var html = "";
        for (var i = 0; i < LANGS.length; i++) {
          html += '<button type="button" data-setlang="' + LANGS[i].code + '"><span>' + LANGS[i].name + '</span><span class="tick">✓</span></button>';
        }
        menu.innerHTML = html;
      }
      return;
    }
    var inner = document.querySelector(".site-header-inner");
    if (!inner) return;
    var html2 = "";
    for (var j = 0; j < LANGS.length; j++) {
      html2 += '<button type="button" data-setlang="' + LANGS[j].code + '"><span>' + LANGS[j].name + '</span><span class="tick">✓</span></button>';
    }
    var wrap = document.createElement("div");
    wrap.className = "header-actions";
    wrap.innerHTML = '<details class="lang-drop" id="langDrop"><summary aria-label="Language">🌐&nbsp; <span id="langLabel">English</span>&nbsp; ▾</summary><div class="lang-menu" role="menu">' + html2 + '</div></details>';
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
    // Switching languages never clears form values — textContent/placeholder
    // updates only touch labelled UI elements, never input .value.
    applyLang(currentLang());
  }

  window.ApnaShiftLang = { set: applyLang, get: currentLang, langs: LANGS, t: t };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
