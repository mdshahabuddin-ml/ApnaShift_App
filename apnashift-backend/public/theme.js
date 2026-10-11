/* ApnaShift shared Appearance module (Light / Dark / System).
 * - Persists choice in localStorage ("apnashift-theme"), default "system".
 * - Applies html[data-theme] + color-scheme; resolves "system" from the OS
 *   and follows live OS changes while in system mode.
 * - Injects one <style id="apnashift-theme-css"> with all dark overrides and
 *   a header theme dropdown (mirrors the language dropdown styling).
 * - Works standalone (index.html) and alongside lang.js (other pages).
 * Pages only need: the tiny pre-paint snippet in <head> (anti-flash) and
 * <script src="theme.js"></script> before </body>. No other edits.
 * Browser globals live here (eslint node env needs the hint below).
 */
/* global window, document, MutationObserver */
(function () {
  "use strict";
  if (window.ApnaShiftTheme) return;

  var KEY = "apnashift-theme";
  var STR = {
    en: { appearance: "Appearance", light: "Light", dark: "Dark", system: "System" },
    hi: { appearance: "दिखावट", light: "लाइट", dark: "डार्क", system: "सिस्टम" },
  };
  var ICONS = { light: "☀", dark: "☾", system: "◐" };

  function stored() {
    try {
      var v = localStorage.getItem(KEY);
      if (v === "light" || v === "dark" || v === "system") return v;
    } catch (e) { /* private mode — fall through to system */ }
    return "system";
  }

  function resolved(mode) {
    if (mode === "dark") return "dark";
    if (mode === "light") return "light";
    try {
      if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
    } catch (e) { /* no matchMedia — fall through to light */ }
    return "light";
  }

  function lang() {
    return document.documentElement.lang === "hi" ? "hi" : "en";
  }

  var CSS =
    'html[data-theme="dark"]{color-scheme:dark;' +
    "--bg:#0b1526;--card:#111f36;--ink:#e9eff8;--muted:#9db0c9;" +
    "--line:#26395e;--blue:#8ab4f8;--green:#34c77b;--red:#ff7a6e;" +
    "--shadow:0 12px 40px rgba(0,0,0,.45)}" +
    /* surfaces + text driven by variables */
    'html[data-theme="dark"] body{background:var(--bg);color:var(--ink)}' +
    'html[data-theme="dark"] h1,html[data-theme="dark"] h2,html[data-theme="dark"] h3{color:#f0f4fa}' +
    'html[data-theme="dark"] .section-title{color:#f2f6fc}' +
    'html[data-theme="dark"] .section-sub,.card-sub,.card .sub,.sub{color:#9db0c9}' +
    /* cards */
    'html[data-theme="dark"] .auth-card,html[data-theme="dark"] .book-card,' +
    'html[data-theme="dark"] .reg-card,html[data-theme="dark"] .login-card,' +
    'html[data-theme="dark"] .contact-card,html[data-theme="dark"] .form-card,' +
    'html[data-theme="dark"] .faq-card,html[data-theme="dark"] .svc,' +
    'html[data-theme="dark"] .panel-card{background:var(--card);box-shadow:0 12px 40px rgba(0,0,0,.45)}' +
    'html[data-theme="dark"] .svc h3,html[data-theme="dark"] .panel-card h3{color:#f0f4fa}' +
    'html[data-theme="dark"] .svc p,html[data-theme="dark"] .panel-card .psub{color:#9db0c9}' +
    'html[data-theme="dark"] .tick-list li{color:#dbe4f2}' +
    /* tinted audience/info cards -> dark tints */
    'html[data-theme="dark"] .aud-card.yellow{background:#1d1a10;border-color:#5a4d1f}' +
    'html[data-theme="dark"] .aud-card.blue{background:#101f38;border-color:#2c4a7c}' +
    'html[data-theme="dark"] .aud-card.green{background:#0e241b;border-color:#1f5c3d}' +
    'html[data-theme="dark"] .aud-body h3{color:#f0f4fa}' +
    'html[data-theme="dark"] .aud-body>p{color:#a9b8cf}' +
    'html[data-theme="dark"] .check-list li{color:#dbe4f2}' +
    'html[data-theme="dark"] .aud-visual{filter:brightness(.82) saturate(.95)}' +
    'html[data-theme="dark"] .why{background:#0f2038}' +
    'html[data-theme="dark"] .how{background:#0d231b}' +
    'html[data-theme="dark"] .tiles li{background:#14263f;color:#dbe4f2;box-shadow:0 3px 12px rgba(0,0,0,.35)}' +
    'html[data-theme="dark"] .steps li{background:rgba(20,38,63,.7);color:#dbe4f2}' +
    'html[data-theme="dark"] .steps li:not(:last-child)::after{color:#5b7192}' +
    'html[data-theme="dark"] .sec-head h2{color:#f0f4fa}' +
    /* hero panels */
    'html[data-theme="dark"] .hero-panel{background:linear-gradient(135deg,#0d1b32 0%,#132540 55%,#241d12 100%)}' +
    'html[data-theme="dark"] .hero-panel h1{color:#f2f6fc}' +
    'html[data-theme="dark"] .hero-sub{color:#b7c4d8}' +
    'html[data-theme="dark"] .badge{background:#16305a;color:#cfe0f7}' +
    'html[data-theme="dark"] .feat b{color:#eef3fa}' +
    'html[data-theme="dark"] .feat small{color:#9db0c9}' +
    'html[data-theme="dark"] .hero{background:#0b1526;border-color:#1c2f55}' +
    'html[data-theme="dark"] .hero-copy h1{color:#f2f6fc}' +
    'html[data-theme="dark"] .hero-sub{color:#a9b8cf}' +
    'html[data-theme="dark"] .hero-city,html[data-theme="dark"] .hero-truck,' +
    'html[data-theme="dark"] .hero-agent,html[data-theme="dark"] .hero-driver,' +
    'html[data-theme="dark"] .veh img,html[data-theme="dark"] .aud-img img{filter:brightness(.88) saturate(.95)}' +
    /* floating cards / bubbles */
    'html[data-theme="dark"] .mini-card,html[data-theme="dark"] .live-bubble{background:#14263f;border-color:#26395e}' +
    'html[data-theme="dark"] .mini-card b,html[data-theme="dark"] .live-bubble b{color:#eef3fa}' +
    'html[data-theme="dark"] .mini-card small,html[data-theme="dark"] .live-bubble small{color:#9db0c9}' +
    'html[data-theme="dark"] .chat-main,html[data-theme="dark"] .badge247{background:#14263f;color:#eef3fa}' +
    'html[data-theme="dark"] .chat-main::after{border-top-color:#14263f}' +
    'html[data-theme="dark"] .badge247 small{color:#9db0c9}' +
    /* how-it-works + faq */
    'html[data-theme="dark"] .how-ic{background:#16263f;color:#e9eff8}' +
    'html[data-theme="dark"] .how-step h3{color:#eef3fa}' +
    'html[data-theme="dark"] .how-step p{color:#9db0c9}' +
    'html[data-theme="dark"] .faq details,html[data-theme="dark"] .faq-card details{background:#111f36;border-color:var(--line)}' +
    'html[data-theme="dark"] .faq summary,html[data-theme="dark"] .faq-card summary{color:#e9eff8}' +
    'html[data-theme="dark"] .faq .answer,html[data-theme="dark"] .faq-card .answer{color:#c4d0e2}' +
    /* forms */
    'html[data-theme="dark"] .field label,html[data-theme="dark"] fieldset legend{color:#eef3fa}' +
    'html[data-theme="dark"] input,html[data-theme="dark"] select,' +
    'html[data-theme="dark"] textarea{background:#0e1a30;color:#e9eff8;border-color:var(--line)}' +
    'html[data-theme="dark"] input::placeholder,html[data-theme="dark"] textarea::placeholder{color:#7d8fa8}' +
    'html[data-theme="dark"] option,html[data-theme="dark"] optgroup{background:#0e1a30;color:#e9eff8}' +
    'html[data-theme="dark"] .hint{color:#9db0c9}' +
    'html[data-theme="dark"] .field.invalid input,html[data-theme="dark"] .field.invalid select,' +
    'html[data-theme="dark"] .field.invalid textarea{border-color:var(--red);background:#2a1210}' +
    'html[data-theme="dark"] .lead-ic,html[data-theme="dark"] .eye-btn,html[data-theme="dark"] .trail-ic{color:#dbe4f2}' +
    'html[data-theme="dark"] .cc{background:#0e1a30;color:#e9eff8;border-color:var(--line)}' +
    'html[data-theme="dark"] .checkline,html[data-theme="dark"] .consentline,' +
    'html[data-theme="dark"] .remember{color:#dbe4f2}' +
    'html[data-theme="dark"] .consentline a{color:#8ab4f8}' +
    'html[data-theme="dark"] .check{background:#14263f;border-color:var(--line);color:#dbe4f2}' +
    'html[data-theme="dark"] .consent{background:#1c1a12;border-color:#5a4d1f;color:#e9eff8}' +
    'html[data-theme="dark"] .loc-status{color:#9db0c9}' +
    'html[data-theme="dark"] .loc-status b{color:#e9eff8}' +
    'html[data-theme="dark"] .review-table th{background:#16263f;color:#e9eff8}' +
    'html[data-theme="dark"] .review-table th,html[data-theme="dark"] .review-table td{border-color:var(--line)}' +
    /* tabs + buttons */
    'html[data-theme="dark"] .tabs{background:#0d1a30}' +
    'html[data-theme="dark"] .tabs button{color:#dbe4f2}' +
    'html[data-theme="dark"] .tabs button.active{background:var(--yellow);color:#0a1931}' +
    'html[data-theme="dark"] .btn.ghost,html[data-theme="dark"] .btn-est,' +
    'html[data-theme="dark"] .btn-outline,html[data-theme="dark"] .modal .ghost-btn{background:#16263f;color:#e9eff8}' +
    'html[data-theme="dark"] .map-btn{background:#13294d;color:#8ab4f8;border-color:#2f5aa0}' +
    'html[data-theme="dark"] .map-btn:hover{background:#18315c}' +
    'html[data-theme="dark"] .fare{background:#141d31}' +
    'html[data-theme="dark"] .fare td{border-color:var(--line)}' +
    'html[data-theme="dark"] .divider{color:#8fa1b9}' +
    'html[data-theme="dark"] .divider::before,html[data-theme="dark"] .divider::after{border-color:var(--line)}' +
    'html[data-theme="dark"] .newhere,html[data-theme="dark"] .links{color:#dbe4f2}' +
    'html[data-theme="dark"] .forgot{color:#8ab4f8}' +
    'html[data-theme="dark"] .backlink{color:#8ab4f8}' +
    'html[data-theme="dark"] .step-names span{color:#7d8fa8}' +
    'html[data-theme="dark"] .step-names span.on{color:#eef3fa}' +
    'html[data-theme="dark"] #stepsBar span::after{background:#16263f;color:#8fa1b9;border-color:var(--line)}' +
    'html[data-theme="dark"] #stepsBar span::before{border-color:var(--line)}' +
    /* modal + misc */
    'html[data-theme="dark"] .modal,html[data-theme="dark"] .map-modal{background:#111f36}' +
    'html[data-theme="dark"] .modal h2,html[data-theme="dark"] .map-modal h2{color:#eef3fa}' +
    'html[data-theme="dark"] .modal p,html[data-theme="dark"] .modal label{color:#c4d0e2}' +
    /* footer keeps navy branding; only soften secondary text */
    'html[data-theme="dark"] .foot-brand small{color:#9db0c9}' +
    /* smooth switch (short-lived class, see setTheme) */
    'html.theming *,html.theming *::before,html.theming *::after' +
    '{transition:background-color .25s ease,color .25s ease,border-color .25s ease,box-shadow .25s ease,filter .25s ease !important}' +
    /* toggle UI (mirrors .lang-drop so it fits every header) */
    '.theme-drop{position:relative}' +
    '.theme-drop summary{list-style:none;cursor:pointer;display:inline-flex;align-items:center;gap:8px;' +
    'color:#fff;font-weight:600;font-size:.9rem;padding:8px 14px;border-radius:10px;' +
    'background:rgba(255,255,255,.03);border:1.2px solid rgba(255,255,255,.28);white-space:nowrap}' +
    '.theme-drop summary::-webkit-details-marker{display:none}' +
    '.theme-drop summary #themeIcon{font-size:1rem;line-height:1}' +
    '.theme-menu{position:absolute;top:calc(100% + 8px);right:0;background:#102e57;border:1px solid #24406b;' +
    'border-radius:12px;padding:6px;min-width:180px;box-shadow:0 12px 30px rgba(0,0,0,.35);z-index:70}' +
    '.theme-menu button{display:flex;width:100%;align-items:center;gap:8px;background:transparent;border:0;' +
    'color:#fff;font:inherit;font-weight:600;font-size:.88rem;padding:10px 12px;border-radius:8px;cursor:pointer;text-align:left}' +
    '.theme-menu button:hover{background:rgba(255,255,255,.12)}' +
    '.theme-menu button.active{background:rgba(255,178,0,.15)}' +
    '.theme-menu .tick{margin-left:auto;color:#ffb200;font-weight:800;visibility:hidden}' +
    '.theme-menu button.active .tick{visibility:visible}' +
    '.theme-menu .t-ic{width:20px;text-align:center}' +
    '@media(max-width:640px){.theme-drop summary #themeLabel{display:none}}';

  function ensureCss() {
    if (document.getElementById("apnashift-theme-css")) return;
    var st = document.createElement("style");
    st.id = "apnashift-theme-css";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function dict() {
    return STR[lang()] || STR.en;
  }

  function ensureUI() {
    if (document.getElementById("themeDrop")) { relabel(); return; }
    var host = document.querySelector(".site-header-inner .header-actions") ||
      document.querySelector(".site-header-inner");
    if (!host) return;
    var wrap = document.createElement("div");
    wrap.innerHTML =
      '<details class="theme-drop" id="themeDrop">' +
      '<summary aria-label="Appearance"><span id="themeIcon" aria-hidden="true">◐</span>' +
      '&nbsp;<span id="themeLabel">System</span>&nbsp; ▾</summary>' +
      '<div class="theme-menu">' +
      '<button type="button" data-theme-set="light"><span class="t-ic">☀</span><span data-t="light">Light</span><span class="tick">✓</span></button>' +
      '<button type="button" data-theme-set="dark"><span class="t-ic">☾</span><span data-t="dark">Dark</span><span class="tick">✓</span></button>' +
      '<button type="button" data-theme-set="system"><span class="t-ic">◐</span><span data-t="system">System</span><span class="tick">✓</span></button>' +
      "</div></details>";
    var drop = wrap.firstChild;
    var hc = (host && host.className) || "";
    if (hc.indexOf("header-actions") !== -1 && host.firstChild) {
      host.insertBefore(drop, host.firstChild);
    } else {
      host.appendChild(drop);
    }
    var btns = drop.querySelectorAll("[data-theme-set]");
    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        b.addEventListener("click", function (ev) {
          ev.preventDefault();
          setTheme(b.getAttribute("data-theme-set"));
        });
      })(btns[i]);
    }
    relabel();
  }

  function relabel() {
    var d = dict();
    var drop = document.getElementById("themeDrop");
    if (!drop) return;
    var map = { light: d.light, dark: d.dark, system: d.system };
    var labels = drop.querySelectorAll("[data-t]");
    for (var i = 0; i < labels.length; i++) {
      var k = labels[i].getAttribute("data-t");
      if (map[k] !== undefined) labels[i].textContent = map[k];
    }
    var mode = stored();
    var lab = document.getElementById("themeLabel");
    if (lab) lab.textContent = map[mode] || map.system;
    var ic = document.getElementById("themeIcon");
    if (ic) ic.textContent = ICONS[mode] || ICONS.system;
    var btns = drop.querySelectorAll("[data-theme-set]");
    for (var j = 0; j < btns.length; j++) {
      btns[j].classList.toggle("active", btns[j].getAttribute("data-theme-set") === mode);
    }
    var sum = drop.querySelector("summary");
    if (sum) sum.setAttribute("aria-label", d.appearance + ": " + (map[mode] || map.system));
  }

  function setTheme(mode) {
    if (mode !== "light" && mode !== "dark" && mode !== "system") mode = "system";
    try { localStorage.setItem(KEY, mode); } catch (e) { /* private mode — skip persist */ }
    var r = resolved(mode);
    document.documentElement.setAttribute("data-theme", r);
    try { document.documentElement.style.colorScheme = r; } catch (e2) { /* headless DOM — skip */ }
    document.documentElement.classList.add("theming");
    window.setTimeout(function () {
      document.documentElement.classList.remove("theming");
    }, 320);
    relabel();
  }

  function init() {
    ensureCss();
    ensureUI();
    setTheme(stored());
    try {
      var mq = window.matchMedia("(prefers-color-scheme: dark)");
      var onChange = function () {
        if (stored() === "system") setTheme("system");
      };
      if (mq.addEventListener) mq.addEventListener("change", onChange);
      else if (mq.addListener) mq.addListener(onChange);
    } catch (e) { /* no matchMedia — static theme */ }
    // Re-label when lang.js flips documentElement.lang.
    try {
      var obs = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          if (muts[i].attributeName === "lang") { relabel(); break; }
        }
      });
      obs.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    } catch (e2) { /* no MutationObserver — labels stay English-initial */ }
  }

  window.ApnaShiftTheme = { set: setTheme, get: stored, resolved: function () { return resolved(stored()); } };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
