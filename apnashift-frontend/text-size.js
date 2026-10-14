/* ApnaShift shared Text Size module (A- / A / A+).
 * - TEXT-ONLY scaling: A+ / A- shift every text element by +/-2px from its
 *   own size. Delta range is [-4px, +8px], so default 16px body text stays
 *   inside the 12px-24px window. A resets to 0 (16px default).
 * - Layout is NEVER touched: only font-size on text elements (headings,
 *   text, links, buttons, labels, form fields). No root font-size, no zoom,
 *   no transform/scale — tile/card dims, images, margins, padding stay put.
 * - Persists delta in localStorage ("apnashift-text-px") site-wide.
 * - Same hooks as before: any [data-tsbtn="dec|reset|inc"] button,
 *   [data-ts-status] live region, window.ApnaShiftTextSize API.
 * - Overflow guard: injected CSS wraps long words instead of overlapping.
 * - MutationObserver picks up dynamically added content (e.g. notifications).
 * Browser globals live here (eslint node env needs the hint below).
 */
/* global window, document, MutationObserver */
(function () {
  "use strict";
  if (window.ApnaShiftTextSize) return;

  var KEY = "apnashift-text-px";
  var LEGACY_KEY = "apnashift-textsize";
  var STEP = 2;
  var MIN = -4;
  var MAX = 8;
  var DEF = 0;
  var BASE_BODY = 16;
  // Text-level elements only — never layout containers (div/section/...),
  // so em-free boxes keep their exact dimensions.
  var SEL = "h1,h2,h3,h4,h5,h6,p,span,a,button,small,li,td,th,label,legend," +
    "summary,dt,dd,em,strong,figcaption,input,textarea,select";

  var cur = DEF;

  function clamp(d) {
    if (isNaN(d)) return DEF;
    if (d < MIN) return MIN;
    if (d > MAX) return MAX;
    return d;
  }

  function stored() {
    try {
      var v = parseInt(localStorage.getItem(KEY), 10);
      if (!isNaN(v)) return clamp(v);
    } catch (e) { /* private mode — fall through to default */ }
    return DEF;
  }

  function baseOf(el) {
    // Capture once: nothing else mutates sizes (no root scaling anywhere),
    // so the first computed value is always the true base.
    if (el.__tsBase == null) {
      var c = parseFloat(window.getComputedStyle(el).fontSize);
      el.__tsBase = isNaN(c) ? BASE_BODY : c;
    }
    return el.__tsBase;
  }

  function paint(d) {
    var els = document.querySelectorAll(SEL);
    for (var i = 0; i < els.length; i++) {
      els[i].style.fontSize = (baseOf(els[i]) + d) + "px";
    }
  }

  function syncUI(d) {
    var btns = document.querySelectorAll("[data-tsbtn]");
    for (var i = 0; i < btns.length; i++) {
      var kind = btns[i].getAttribute("data-tsbtn");
      if (kind === "dec") {
        if (d === MIN) btns[i].setAttribute("disabled", "disabled");
        else btns[i].removeAttribute("disabled");
      } else if (kind === "inc") {
        if (d === MAX) btns[i].setAttribute("disabled", "disabled");
        else btns[i].removeAttribute("disabled");
      } else if (kind === "reset") {
        btns[i].setAttribute("aria-pressed", d === DEF ? "true" : "false");
      }
    }
    var st = document.querySelector("[data-ts-status]");
    if (st) st.textContent = "Text size " + (BASE_BODY + d) + "px";
  }

  function apply(d) {
    cur = clamp(d);
    try {
      localStorage.setItem(KEY, String(cur));
    } catch (e) { /* private mode — skip persist */ }
    try {
      localStorage.removeItem(LEGACY_KEY);
    } catch (e2) { /* ignore */ }
    document.documentElement.setAttribute("data-textpx", String(cur));
    if (document.body) paint(cur);
    syncUI(cur);
    return cur;
  }

  function step(n) {
    return apply(cur + n * STEP);
  }

  function ensureCss() {
    if (document.getElementById("apnashift-textsize-css")) return;
    var st = document.createElement("style");
    st.id = "apnashift-textsize-css";
    // Wrap long words inside text elements so larger type never overlaps
    // neighbours. Containers keep their size; text flows within them.
    st.textContent = "h1,h2,h3,h4,h5,h6,p,span,a,button,small,li,td,th," +
      "label,legend,summary,dt,dd,em,strong,figcaption{overflow-wrap:break-word}";
    document.head.appendChild(st);
  }

  function wire() {
    var btns = document.querySelectorAll("[data-tsbtn]");
    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        if (b.__tsWired) return;
        b.__tsWired = true;
        b.addEventListener("click", function (ev) {
          ev.preventDefault();
          var kind = b.getAttribute("data-tsbtn");
          if (kind === "dec") step(-1);
          else if (kind === "inc") step(1);
          else apply(DEF);
        });
      })(btns[i]);
    }
  }

  function watch() {
    if (!window.MutationObserver || !document.body) return;
    var t = null;
    var obs = new MutationObserver(function () {
      if (t) return;
      t = window.setTimeout(function () {
        t = null;
        paint(cur);
      }, 150);
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  function init() {
    ensureCss();
    try {
      localStorage.removeItem(LEGACY_KEY);
    } catch (e0) { /* ignore */ }
    cur = stored();
    document.documentElement.setAttribute("data-textpx", String(cur));
    if (document.body) paint(cur);
    syncUI(cur);
    wire();
    watch();
  }

  window.ApnaShiftTextSize = {
    dec: function () { return step(-1); },
    inc: function () { return step(1); },
    reset: function () { return apply(DEF); },
    get: function () { return cur; },
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
