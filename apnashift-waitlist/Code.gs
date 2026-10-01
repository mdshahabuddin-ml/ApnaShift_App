/**
 * ApnaShift Waitlist — Google Apps Script backend
 * File: apnashift-waitlist/Code.gs
 *
 * SETUP STEPS (one-time only):
 *
 * 1. Create sheet:
 *    - Create a new Google Sheet at https://sheets.google.com.
 *    - Name it: "ApnaShift Waitlist" (any name works).
 *
 * 2. Paste code:
 *    - In the sheet: click Extensions > Apps Script.
 *    - In the file named Code.gs, paste this file's ENTIRE code, press Save.
 *
 * 3. Create summary sheet (run once):
 *    - In the Apps Script editor, select "setupSummary" from the top function dropdown.
 *    - Press Run; Allow permission if Google asks.
 *    - Back in the Sheet: both "Waitlist" + "Summary" tabs will be created.
 *
 * 4. Deploy web app:
 *    - In Apps Script: click Deploy > New deployment.
 *    - Type: choose "Web app".
 *    - "Execute as:" choose Me.
 *    - "Who has access:" choose Anyone.
 *    - Press Deploy, copy the resulting Web App URL.
 *    - Paste this URL into const SCRIPT_URL = "..." in your index.html.
 *
 * 5. When code changes:
 *    - After editing + saving code: Deploy > Manage deployments > Edit > New version > Deploy.
 *    - (Without deploying a new version, old code keeps running — don't forget!)
 *
 * Test: After deploy, open the URL in a browser (runs doGet).
 * Form POST: index.html sends POST via fetch(), response is {ok:true}.
 */

// Sheet + column setting
var SHEET_NAME = "Waitlist";
var SUMMARY_SHEET_NAME = "Summary";
// Columns: Time, Name, Phone, City/Area, What to shift, By when, Note, Source
var HEADERS = ["Time", "Name", "Phone", "City/Area", "Kya shift karna hai", "Kab tak", "Note", "Source"];

// Must match index.html dropdown options — invalid curl values stop here
// (response ok:false + specific error, no Sheet row).
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
// ?src= codes (7 from links.md + direct/share/curl/test). To add a new campaign code
// add it here + in links.md, else invalid_source occurs.
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
 * Make every text safe:
 * - trim, max 300 chars
 * - if it starts with =, +, -, @, prefix with ' (prevents formula injection)
 */
function safeText(v) {
  var s = String(v === undefined || v === null ? "" : v).trim();
  // Trim emoji safely: Array.from counts one emoji as 1,
  // so slice does not split a surrogate pair.
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
 * Clean phone: remove non-digits, keep last 10 digits.
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
 * Get "Waitlist" sheet, or create it with headers if missing.
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
    // Keep phone as text so Sheet does not convert it to a number
    sh.getRange("C:C").setNumberFormat("@");
    return sh;
  }
  // If sheet exists but header is damaged (manual edit / wrong order)
  // then restore the first row so column mapping stays intact.
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
 * Main: receives POST from form.
 * Frontend (index.html) sends JSON body via fetch():
 *   new names: {name, phone, city, type, when, note, source, website}
 *   old names (previous index.html): {naam, phone, city, what, when, note, source, company}
 * Support both so the old page does not break.
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonOut({ ok: false, error: "empty_request" });
    }

    // Block oversized payloads (spam/attack) before parsing
    if (e.postData.contents.length > 25000) {
      return jsonOut({ ok: false, error: "too_large" });
    }

    var data;
    try {
      data = JSON.parse(e.postData.contents);
    } catch (err) {
      // On invalid/broken JSON, do not crash, return ok:false only
      return jsonOut({ ok: false, error: "invalid_json" });
    }
    if (!data || typeof data !== "object") {
      return jsonOut({ ok: false, error: "invalid_json" });
    }

    // --- Honeypot: hidden field to catch bots ---
    // New name "website", old name "company". If filled, ignore silently.
    var honeypot = String(
      data.website !== undefined ? data.website :
      data.company !== undefined ? data.company :
      data.honeypot !== undefined ? data.honeypot : ""
    ).trim();
    if (honeypot !== "") {
      // Respond to spam as success, but write nothing to the sheet.
      return jsonOut({ ok: true });
    }

    // --- Support both naming schemes ---
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

    // Phone is required: 10-digit Indian mobile
    if (!/^[6-9]\d{9}$/.test(phone)) {
      return jsonOut({ ok: false, error: "invalid_phone" });
    }
    // False if name/city is empty (frontend blocks this; double safety)
    if (!name || !city) {
      return jsonOut({ ok: false, error: "missing_fields" });
    }

    // Consent is required: form checkbox for contact consent.
    // Reject if missing / false (for DPDP consent).
    var consent = data.consent;
    var hasConsent = (consent === true || consent === 1 ||
      consent === "true" || consent === "1" ||
      consent === "on" || consent === "yes");
    if (!hasConsent) {
      return jsonOut({ ok: false, error: "consent_required" });
    }

    // Allowlist check for type/when/source (must match dropdown/?src= options).
    // Invalid curl/devtools values stop here — no Sheet row.
    if (ALLOWED_TYPES.indexOf(type) === -1) {
      return jsonOut({ ok: false, error: "invalid_type" });
    }
    if (ALLOWED_WHENS.indexOf(when) === -1) {
      return jsonOut({ ok: false, error: "invalid_when" });
    }
    if (ALLOWED_SOURCES.indexOf(source) === -1) {
      return jsonOut({ ok: false, error: "invalid_source" });
    }

    // Acquire lock to prevent races
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
    } catch (lockErr) {
      // Proceed even if lock is unavailable (rare case)
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
            // Do not add a duplicate row, but still return success JSON
            return jsonOut({ ok: true, duplicate: true });
          }
        }
      }

      // Append new row
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
    // Do not crash on any unknown error
    return jsonOut({ ok: false, error: "server_error" });
  }
}

/**
 * Runs when Web App URL is opened in a browser (health check).
 */
function doGet() {
  return jsonOut({ ok: true, message: "ApnaShift waitlist backend chal raha hai. POST se data bhejo." });
}

/**
 * SETUP FUNCTION: create "Summary" sheet (with formulas).
 * Run this function once in the Apps Script editor.
 *
 * Summary shows:
 * - total signups
 * - signups for "Is hafte"
 * - source-wise count (auto table)
 * - city-wise count (auto table)
 */
function setupSummary() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // Ensure Waitlist sheet exists first (with headers)
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
  // Count in Name column (B) — excluding header row
  sh.getRange("B5").setFormula('=IFERROR(COUNTA(Waitlist!B2:B),0)');

  sh.getRange("A6").setValue("Is hafte wale signups");
  // "Kab tak" column is F
  sh.getRange("B6").setFormula('=IFERROR(COUNTIF(Waitlist!F2:F,"Is hafte"),0)');

  sh.getRange("A7").setValue("Sirf jaankari chahiye");
  sh.getRange("B7").setFormula('=IFERROR(COUNTIF(Waitlist!F2:F,"Sirf jaankari chahiye"),0)');

  // Source-wise table (auto-expands below A9)
  sh.getRange("A9").setValue("Source-wise count (auto)");
  sh.getRange("A9").setFontWeight("bold");
  sh.getRange("A10").setFormula(
    '=IFERROR(QUERY(Waitlist!H2:H,"select H, count(H) where H is not null group by H label H \'Source\', count(H) \'Count\'",1),"Source nahi mila — pehli entry ka intezaar hai.")'
  );

  // City-wise table (auto-expands below D9 — aside to avoid Source table overlap)
  sh.getRange("D9").setValue("City-wise count (auto)");
  sh.getRange("D9").setFontWeight("bold");
  sh.getRange("D10").setFormula(
    '=IFERROR(QUERY(Waitlist!D2:D,"select D, count(D) where D is not null group by D order by count(D) desc label D \'City / Area\', count(D) \'Count\'",1),"City nahi mili — pehli entry ka intezaar hai.")'
  );

  SpreadsheetApp.flush();
}
