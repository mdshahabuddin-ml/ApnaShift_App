# ApnaShift Waitlist — Testing Guide (Hinglish)

Deploy ke baad ye 4 test karo. Yaad rakho: form `no-cors` se bhejta hai,
isliye browser me jawab nahi dikhega — **Sheet hi source of truth hai.**
Har test ke baad Sheet refresh karke dekho.

## 0. Deploy checklist (test se pehle)

1. Apps Script me `setupSummary` ek baar Run kiya? (Waitlist + Summary tabs bane?)
2. Deploy > New deployment > Web app — Execute as: **Me**, Access: **Anyone**?
3. Web App URL copy karke `index.html` ke `const SCRIPT_URL` me paste kiya?
4. Baad me code badla ho to Manage deployments > **New version** > Deploy kiya?

## 1. Health check (backend chal raha?)

- Web App URL browser me kholo.
- Dikhna chahiye: `{"ok":true,"message":"ApnaShift waitlist backend chal raha hai..."}`
- Nahi dikhe to: deployment "Anyone" hai ya nahi, ye check karo.

## 2. Test entries (4 test)

### Test 1 — Normal entry (form se)
- Page kholo, bharo:
  - Naam: `Rahul Sharma`
  - Phone: `98765 43210`
  - Sheher: `Indore – Vijay Nagar`
  - Kya: `Poora ghar/flat`, Kab: `Is mahine`, Note khaali
- Submit → `Shukriya! Aap list mein hain.` dikhe.
- **Sheet me dikhna chahiye:** Waitlist me nayi row —
  Time (date), Name `Rahul Sharma`, Phone `9876543210` (bina space),
  City `Indore – Vijay Nagar`, Type `Poora ghar/flat`, Kab `Is mahine`,
  Note khaali, Source `direct`.

### Test 2 — Source tracking (`?src=`)
- URL kholo: `index.html?src=flyer`, bharo:
  - Naam: `Priya Verma`, Phone: `91234 56789`
  - Sheher: `Bhopal – Arera Colony`, Kya: `Sirf furniture`,
  - Kab: `Is hafte`, Note: `2nd floor, lift nahi hai`
- **Sheet me dikhna chahiye:** nayi row, Source column me `flyer`.
- **Summary me:** Total `2`, "Is hafte" `1`, Source-wise me `direct:1, flyer:1`.

### Test 3 — Duplicate phone (dobara row nahi)
- Wapas Test 1 wala phone `9876543210` kisi aur naam se bhejo.
- Form par success dikhega (ye sahi hai — user ko error nahi dikhana).
- **Sheet me dikhna chahiye:** koi nayi row **nahi**, Total same rahe.
- Backend `{ok:true, duplicate:true}` deta hai (browser me nahi dikhega).

### Test 4 — Spam + lamba note + emoji
- (a) Honeypot: curl se bhejo (neeche command), `website` bhara ho —
  **Sheet me nayi row nahi aani chahiye**, jawab `{ok:true}`.
- (b) Note me `=SUM(A1)` likhkar bhejo —
  **Sheet me `'=SUM(A1)` dikhna chahiye** (aage `'` ke saath, formula na chale).
- (c) Naam `Amit 😀 Sharma`, 300+ akshar ka note bhejo —
  naam sahi save ho, note **300 akshar par kata hua**, toota emoji nahi.

## 3. curl se direct test (optional, fast)

URL ko `SCRIPT_URL` se badal lo:

```bash
# Normal entry
curl -X POST -H "Content-Type: text/plain" \
  -d '{"name":"Curl Test","phone":"+91 99999 11111","city":"Test City","type":"Chhota samaan/boxes","when":"Is mahine","note":"curl wala test","source":"curl","website":""}' \
  "SCRIPT_URL"

# Duplicate (dobara bhejo — row nahi badhni chahiye)
curl -X POST -H "Content-Type: text/plain" \
  -d '{"name":"Curl Test 2","phone":"9999911111","city":"Test City","type":"Chhota samaan/boxes","when":"Is mahine","note":"","source":"curl","website":""}' \
  "SCRIPT_URL"

# Spam (honeypot bhara — row nahi aani chahiye)
curl -X POST -H "Content-Type: text/plain" \
  -d '{"name":"Spam Bot","phone":"9999911112","city":"X","type":"X","when":"Is hafte","note":"","source":"spam","website":"http://spam.com"}' \
  "SCRIPT_URL"

# Broken JSON (jawab ok:false, crash nahi)
curl -X POST -H "Content-Type: text/plain" -d '{{{tutaa json' "SCRIPT_URL"
```

curl wala jawab terminal me dikhega (`ok:true` / `ok:false`).
Form (`no-cors`) me jawab nahi dikhta — farak yahi hai, ghabrana mat.

## 4. Summary sheet me kya dikhe

- `Total signups` = Waitlist rows (header chhod kar).
- `Is hafte wale signups` = sirf "Is hafte" wale.
- `Source-wise count` aur `City-wise count` tables khud badhti hain (QUERY se).
- Numbers turant na badle to Sheet refresh karo, 1 min ruko.

## 5. Fail ho to

- Row nahi aayi? → SCRIPT_URL sahi paste hai? Deployment **Anyone**? Code badalne ke baad **New version** deploy kiya?
- `ok:false, invalid_phone`? → 10 digit, `6-9` se shuru wala number bhejo.
- Summary me error? → `setupSummary` dobara Run karo.
- Purana page + naya backend? → dono naam (`naam`/`name`, `what`/`type`, `company`/`website`) support hain, chalega.
