/**
 * ApnaShift Waitlist — Google Apps Script backend
 * File: apnashift-waitlist/Code.gs
 *
 * SETUP STEPS (sirf ek baar karna hai):
 *
 * 1. Sheet banana:
 *    - https://sheets.google.com par naya Google Sheet banao.
 *    - Naam rakho: "ApnaShift Waitlist" (kuch bhi chalega).
 *
 * 2. Code paste karna:
 *    - Sheet mein: Extensions > Apps Script par click karo.
 *    - Code.gs naam ki file mein is file ka POORA code paste karo, Save dabao.
 *
 * 3. Summary sheet banana (ek baar chalana hai):
 *    - Apps Script editor mein upar function dropdown se "setupSummary" chuno.
 *    - Run dabao, Google se permission maange to Allow karo.
 *    - Wapas Sheet mein dekho: "Waitlist" + "Summary" dono tabs ban jayenge.
 *
 * 4. Web app deploy karna:
 *    - Apps Script mein: Deploy > New deployment par click karo.
 *    - Type: "Web app" chuno.
 *    - "Execute as:" Me chuno.
 *    - "Who has access:" Anyone chuno.
 *    - Deploy dabao, jo Web App URL mile use copy karo.
 *    - Ye URL apne index.html mein const SCRIPT_URL = "..." mein paste karo.
 *
 * 5. Code badalne par:
 *    - Code edit + Save ke baad: Deploy > Manage deployments > Edit > New version > Deploy.
 *    - (Naya version deploy kiye bina purana code hi chalega — ye bhoolna mat!)
 *
 * Test: Deploy ke baad URL ko browser mein kholo (doGet chalega).
 * Form POST: index.html se fetch() POST karta hai, jawab {ok:true} aata hai.
 */

// Sheet + column setting
var SHEET_NAME = "Waitlist";
var SUMMARY_SHEET_NAME = "Summary";
// Columns: Time, Name, Phone, City/Area, Kya shift karna hai, Kab tak, Note, Source
var HEADERS = ["Time", "Name", "Phone", "City/Area", "Kya shift karna hai", "Kab tak", "Note", "Source"];

// index.html ke dropdown options se match karte hain — curl se aaya galat
// value yahin rokta hai (jawab ok:false + specific error, Sheet me row nahi).
var ALLOWED_TYPES = [
  "Poora ghar/flat",
  "Sirf furniture",
  "Dukaan/office ka samaan",
  "Chhota samaan/boxes",
  "Abhi pata nahi"
];
var ALLOWED_WHENS = [
  "Is hafte",
  "Is mahine",
  "1-3 mahine mein",
  "Sirf jaankari chahiye"
];
// ?src= codes (links.md wale 7 + direct/share/curl/test). Naya campaign code
// jodna ho to yahan + links.md dono me jodo, nahi to invalid_source aayega.
var ALLOWED_SOURCES = [
  "direct",
  "status",
  "college",
  "society",
  "facebook",
  "friends",
  "instagram",
  "flyer",
  "share",
  "curl",
  "test"
];

/**
 * Har text ko safe banao:
 * - trim, max 300 chars
 * - agar =, +, -, @ se shuru ho to aage ' laga do (formula injection se bachav)
 */
function safeText(v) {
  var s = String(v === undefined || v === null ? "" : v).trim();
  // Emoji surakshit kaato: Array.from ek emoji ko 1 ginta hai,
  // taaki slice beech mein se surrogate pair na tode.
  var chars = Array.from(s);
  if (chars.length > 300) {
    s = chars.slice(0, 300).join("");
  }
  if (/^[=+\-@]/.test(s)) {
    s = "'" + s;
  }
  return s;
}

/**
 * Phone saaf karo: non-digits hatao, last 10 digits rakho.
 * Example: "+91 98765 43210" -> "9876543210"
 */
function cleanPhoneNumber(v) {
  var digits = String(v === undefined || v === null ? "" : v).replace(/\D/g, "");
  if (digits.length > 10) {
    digits = digits.slice(-10);
  }
  return digits;
}

/**
 * "Waitlist" sheet lao, na ho to headers ke saath bana do.
 */
function getWaitlistSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold");
    sh.setColumnWidths(1, HEADERS.length, 160);
    sh.getRange("A:A").setNumberFormat("dd-mmm-yyyy hh:mm:ss");
    // Phone text ki tarah rakho taaki Sheet number mein na badle
    sh.getRange("C:C").setNumberFormat("@");
    return sh;
  }
  // Sheet pehle se ho par header bigda ho (haath se edit / galat order)
  // to pehli row wapas sahi kar do, taaki column mapping na toote.
  var head = sh.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  var ok = true;
  for (var i = 0; i < HEADERS.length; i++) {
    if (String(head[i]).trim() !== HEADERS[i]) {
      ok = false;
      break;
    }
  }
  if (!ok) {
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sh.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold");
    sh.setFrozenRows(1);
  }
  return sh;
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Main: form se POST aata hai.
 * Frontend (index.html) fetch() se JSON body bhejta hai:
 *   naya naam: {name, phone, city, type, when, note, source, website}
 *   purana naam (pichla index.html): {naam, phone, city, what, when, note, source, company}
 * Dono ko support karte hain taaki purana page na toote.
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonOut({ ok: false, error: "empty_request" });
    }

    // Bahut bada payload aaye (spam/attack) to parse karne se pehle roko
    if (e.postData.contents.length > 25000) {
      return jsonOut({ ok: false, error: "too_large" });
    }

    var data;
    try {
      data = JSON.parse(e.postData.contents);
    } catch (err) {
      // Galat/broken JSON par crash nahi, sirf ok:false
      return jsonOut({ ok: false, error: "invalid_json" });
    }
    if (!data || typeof data !== "object") {
      return jsonOut({ ok: false, error: "invalid_json" });
    }

    // --- Honeypot: bot pakadne wala hidden field ---
    // Naya naam "website", purana naam "company". Bhara ho to chup-chaap ignore.
    var honeypot = String(
      data.website !== undefined ? data.website :
      data.company !== undefined ? data.company :
      data.honeypot !== undefined ? data.honeypot : ""
    ).trim();
    if (honeypot !== "") {
      // Spam ko success jaisa jawab do, par sheet mein kuch mat likho.
      return jsonOut({ ok: true });
    }

    // --- Dono naming schemes support karo ---
    var rawName = data.name !== undefined ? data.name : data.naam;
    var rawCity = data.city !== undefined ? data.city : data.area;
    var rawType = data.type !== undefined ? data.type : (data.what !== undefined ? data.what : data.kya);
    var rawWhen = data.when !== undefined ? data.when : data.kab;
    var rawSource = data.source !== undefined ? data.source : data.src;

    var name = safeText(rawName);
    var phone = cleanPhoneNumber(data.phone);
    var city = safeText(rawCity);
    var type = safeText(rawType);
    var when = safeText(rawWhen);
    var note = safeText(data.note);
    var source = safeText(rawSource) || "direct";
    if (!source) {
      source = "direct";
    }

    // Phone zaroori hai: 10 digit Indian mobile
    if (!/^[6-9]\d{9}$/.test(phone)) {
      return jsonOut({ ok: false, error: "invalid_phone" });
    }
    // Naam/city khaali ho to bhi false (frontend pehle hi rokta hai, ye double safety hai)
    if (!name || !city) {
      return jsonOut({ ok: false, error: "missing_fields" });
    }

    // Consent zaroori hai: form wala checkbox "contact ke liye number deta hoon".
    // Na bhejo / false ho to reject (DPDP consent ke liye).
    var consent = data.consent;
    var hasConsent = (consent === true || consent === 1 ||
      consent === "true" || consent === "1" ||
      consent === "on" || consent === "yes");
    if (!hasConsent) {
      return jsonOut({ ok: false, error: "consent_required" });
    }

    // type/when/source allowlist check (dropdown/?src= options se match).
    // Curl/devtools se aaya galat value yahin rokta hai — Sheet me row nahi.
    if (ALLOWED_TYPES.indexOf(type) === -1) {
      return jsonOut({ ok: false, error: "invalid_type" });
    }
    if (ALLOWED_WHENS.indexOf(when) === -1) {
      return jsonOut({ ok: false, error: "invalid_when" });
    }
    if (ALLOWED_SOURCES.indexOf(source) === -1) {
      return jsonOut({ ok: false, error: "invalid_source" });
    }

    // Race se bachne ke liye lock lagao
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
    } catch (lockErr) {
      // Lock na mile to bhi aage badho (rare case)
    }

    try {
      var sh = getWaitlistSheet();
      var lastRow = sh.getLastRow();

      // --- Duplicate phone check (column C = Phone) ---
      if (lastRow >= 2) {
        var phones = sh.getRange(2, 3, lastRow - 1, 1).getValues();
        for (var i = 0; i < phones.length; i++) {
          var oldPhone = cleanPhoneNumber(phones[i][0]);
          if (oldPhone === phone) {
            // Dobara row mat jodo, par success JSON hi return karo
            return jsonOut({ ok: true, duplicate: true });
          }
        }
      }

      // Nayi row jodo
      sh.appendRow([new Date(), name, phone, city, type, when, note, source]);
    } finally {
      try {
        lock.releaseLock();
      } catch (e2) {
        // ignore
      }
    }

    return jsonOut({ ok: true });
  } catch (err2) {
    // Kisi bhi anjaan error par crash nahi
    return jsonOut({ ok: false, error: "server_error" });
  }
}

/**
 * Browser mein Web App URL kholne par ye chalta hai (health check).
 */
function doGet() {
  return jsonOut({ ok: true, message: "ApnaShift waitlist backend chal raha hai. POST se data bhejo." });
}

/**
 * SETUP FUNCTION: "Summary" sheet banao (formulas ke saath).
 * Apps Script editor mein is function ko ek baar Run karo.
 *
 * Summary mein dikhega:
 * - total signups
 * - "Is hafte" wale signups
 * - source-wise count (auto table)
 * - city-wise count (auto table)
 */
function setupSummary() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // Pehle Waitlist sheet pakki karo (headers ke saath)
  getWaitlistSheet();

  var sh = ss.getSheetByName(SUMMARY_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SUMMARY_SHEET_NAME);
  }
  sh.clear();
  sh.setColumnWidths(1, 5, 200);

  // Title
  sh.getRange("A1").setValue("ApnaShift — Waitlist Summary");
  sh.getRange("A1").setFontWeight("bold").setFontSize(14);
  sh.getRange("A2").setValue("Last updated:");
  sh.getRange("B2").setFormula("=NOW()");
  sh.getRange("B2").setNumberFormat("dd-mmm-yyyy hh:mm:ss");

  // Metrics
  sh.getRange("A4").setValue("Metric");
  sh.getRange("B4").setValue("Value");
  sh.getRange("A4:B4").setFontWeight("bold");

  sh.getRange("A5").setValue("Total signups");
  // Name column (B) mein ginti — header row ko chhod kar
  sh.getRange("B5").setFormula('=IFERROR(COUNTA(Waitlist!B2:B),0)');

  sh.getRange("A6").setValue("Is hafte wale signups");
  // "Kab tak" column F hai
  sh.getRange("B6").setFormula('=IFERROR(COUNTIF(Waitlist!F2:F,"Is hafte"),0)');

  sh.getRange("A7").setValue("Sirf jaankari chahiye");
  sh.getRange("B7").setFormula('=IFERROR(COUNTIF(Waitlist!F2:F,"Sirf jaankari chahiye"),0)');

  // Source-wise table (A9 se neeche auto badhegi)
  sh.getRange("A9").setValue("Source-wise count (auto)");
  sh.getRange("A9").setFontWeight("bold");
  sh.getRange("A10").setFormula(
    '=IFERROR(QUERY(Waitlist!H2:H,"select H, count(H) where H is not null group by H label H \'Source\', count(H) \'Count\'",1),"Source nahi mila — pehli entry ka intezaar hai.")'
  );

  // City-wise table (D9 se neeche auto badhegi — side mein taaki Source table se takraye nahi)
  sh.getRange("D9").setValue("City-wise count (auto)");
  sh.getRange("D9").setFontWeight("bold");
  sh.getRange("D10").setFormula(
    '=IFERROR(QUERY(Waitlist!D2:D,"select D, count(D) where D is not null group by D order by count(D) desc label D \'City / Area\', count(D) \'Count\'",1),"City nahi mili — pehli entry ka intezaar hai.")'
  );

  SpreadsheetApp.flush();
}
