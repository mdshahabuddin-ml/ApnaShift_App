# ApnaShift Waitlist — README (Hinglish, Beginner Guide)

Ye folder ek simple waitlist page + uska backend hai. Koi paid service nahi,
koi framework nahi. Sirf demand check karne ke liye hai — booking system nahi.

**Folder me kya hai:**
- `index.html` — waitlist page (form, design, sab kuch ek file me)
- `Code.gs` — Google Apps Script backend (Sheet me entry jodta hai)
- `TESTING.md` — deploy ke baad test kaise karein
- `links.md` — `?src=` tracking links kaise banayein
- `outreach.md` — WhatsApp/Facebook ke message templates

**Chahiye:** Google account (Sheet ke liye). Hosting ke liye GitHub account
ya Netlify account (dono free hain, sirf ek chahiye).

---

## 1. Google Sheet banana

1. Browser me `sheets.google.com` kholo, Google se login karo.
2. Upar `+ Blank spreadsheet` (khali sheet, plus wala button) dabao.
3. Upar title par click karke naam rakho: `ApnaShift Waitlist`.
4. Is tab ko khula rakho — agle step me kaam aayega.

## 2. Apps Script me Code.gs paste karna

1. Sheet ke upar menu me **Extensions** par click karo, phir **Apps Script** chuno.
   Naya tab khulega (script.google.com wala editor).
2. Baayein side `Code.gs` naam ki file dikhegi. Usme jo sample code hai, sab
   select karke delete karo.
3. Apne computer se `apnashift-waitlist/Code.gs` file kholo, **poora code copy**
   karke editor me paste karo.
4. Upar **Save** (floppy disk icon) dabao. Naam maange to `ApnaShift Waitlist` do.
5. Ab Summary sheet banao: editor ke upar function wala dropdown (likha hoga
   `doGet` ya `doPost`) — usme **`setupSummary`** chuno, phir uske bagal wala
   **Run** (play/triangle icon) dabao.
6. Pehli baar Google permission maangega: **Review permissions → apna account
   chuno → Advanced → Go to project → Allow** dabao.
7. Wapas Sheet wale tab me jao, neeche dekho: **`Waitlist`** aur **`Summary`**
   naam ke do tabs ban gaye honge. `Waitlist` me pehli row me headings hongi
   (Time, Name, Phone...). Nahi dikhe to Sheet refresh karo.

## 3. Web app deploy karna aur URL copy karna

1. Apps Script editor me upar daayein **Deploy** button dabao, phir
   **New deployment** chuno.
2. Daayein gear/settings icon ke paas **Select type** par click karke
   **Web app** chuno.
3. Do setting dhyaan se karo:
   - **Execute as:** `Me` chuno.
   - **Who has access:** `Anyone` chuno. (Ye nahi kiya to form kaam nahi karega.)
4. **Deploy** dabao. Permission phir maange to Allow karo.
5. Jo **Web App URL** dikhega (`https://script.google.com/macros/s/.../exec`
   jaisa), usse **Copy** karke Notepad me rakh lo. Ye hi tumhara backend link hai.

## 4. URL ko index.html ke SCRIPT_URL me lagana

1. Computer me `apnashift-waitlist/index.html` file ko Notepad/VS Code me kholo.
2. Line dhoondo (Ctrl+F karo): `const SCRIPT_URL = "PASTE_URL_HERE"`.
3. `PASTE_URL_HERE` ki jagah upar copy kiya Web App URL paste karo:
   ```js
   const SCRIPT_URL = "https://script.google.com/macros/s/TUMHARA-CODE/exec";
   ```
   Dhyaan rahe: double-quote ke andar ho, aage-peeche space na ho.
4. File **Save** karo.

## 5. Free hosting (koi ek karo — GitHub Pages ya Netlify)

Hosting ka matlab: `index.html` internet par daalna taaki link sabko bhej sako.
**`Code.gs` hosting par mat daalo** — wo sirf Apps Script me rehta hai.
Sirf `index.html` chahiye.

### Option A: GitHub Pages (thoda lamba, par permanent link)

1. `github.com` par login karo, upar `+` (New) → **New repository** dabao.
2. Naam rakho `apnashift-waitlist`, **Public** rakho, **Create repository** dabao.
3. **Add file** button → **Upload files** chuno, apni `index.html` drag karke
   **Commit changes** dabao. (Folder upload kiya to link me folder ka naam
   jud jayega — neeche note dekho.)
4. Repo ke upar **Settings** tab → baayein menu me **Pages** chuno.
5. **Build and deployment** me: Source `Deploy from a branch`, Branch `main`
   aur folder `/ (root)` chuno, **Save** dabao.
6. 1–2 min ruko, wahi Pages wale section me tumhara link aa jayega:
   `https://TUMHARA-NAAM.github.io/apnashift-waitlist/` (repo naam ke hisaab se).
   - Agar `index.html` repo ke root me hai to link seedha page kholega.
   - Agar `apnashift-waitlist/` folder upload kiya to link ke aage
     `/apnashift-waitlist/` jud jayega — wahi poora link share karo.

### Option B: Netlify drag-and-drop (sabse tez)

1. `app.netlify.com/drop` kholo, Netlify par login/signup karo (free).
2. Computer me `apnashift-waitlist` folder kholo — **sirf `index.html` wali copy**
   alag folder me rakho (naam kuch bhi, example `site`), taaki extra files
   upload na hon.
3. Us folder ko browser wale **drag-and-drop box** me ghaseeto (drag karo).
   Upload hote hi Netlify ek link dega, jaise
   `https://funny-name-123.netlify.app`.
4. Naam badalna ho to: **Site settings → General → Site details → Change site
   name** me jaakar badal lo.
5. Wahi link tumhara live form link hai — ise `links.md` wale tareeke se
   `?src=` lagakar share karo.

## 6. Live link pe test entry bharna aur Sheet me check karna

1. Live link (GitHub ya Netlify wala) browser me kholo.
2. Test entry bharo: Naam `Test User`, Phone `98765 43210`,
   Sheher `Indore – Test Area`, Kya `Chhota samaan/boxes`,
   Kab `Is mahine`, Note khaali. **Submit** dabao.
3. `Shukriya! Aap list mein hain.` dikhe to form sahi gaya.
4. Sheet kholo → `Waitlist` tab me **nayi row** aayi hogi (Time, Name, Phone
   `9876543210`, City, ... Source `direct`).
5. `Summary` tab me **Total signups `1`** dikhega. (Turant na badle to refresh
   karke 1 min ruko.)
6. Baaki 3 test (source, duplicate, spam) ke liye `TESTING.md` follow karo.
   Test rows baad me Sheet se delete kar dena taaki asli ginti saaf rahe.

## 7. Code badalne par "New version" deploy karna (zaroori!)

Apps Script me code badal kar sirf Save karne se live URL **nahi** badalta.
Hamesha ye karo:

1. Apps Script editor me **Deploy** → **Manage deployments** kholo.
2. Web app wali line me **pencil (Edit) icon** dabao.
3. **Version** dropdown me **New version** chuno, **Deploy** dabao.
4. URL same rehta hai — `index.html` me kuch badalne ki zaroorat nahi
   (backend ka fix turant live ho jata hai).

## 8. Common problems — "Submit nahi hua" to kya check karein

| Dikkat | Check karo |
|---|---|
| `Form abhi backend se juda nahi hai` dikhe | `SCRIPT_URL` me abhi bhi `PASTE_URL_HERE` hai. Step 4 dobara karo, file Save karke **dobara upload** karo (GitHub/Netlify par purani file live hogi). |
| Submit dabane par kuch nahi hota / error | Phone 10 digit hai? `6-9` se shuru? Naam 2 akshar se zyada? Laal wali line padho — wahi batayegi kya sudharna hai. |
| Success dikha par Sheet me row nahi | Deployment me **Who has access: Anyone** hai? Nahi to Step 3 dobara + **New version** deploy karo. Phir nayi entry bhejo (purani dobara nahi jayegi). |
| Code fix kiya par farak nahi pada | Step 7 wala **New version** deploy karna bhool gaye. Wahi karo. |
| GitHub Pages par 404 aaye | Pages me Branch `main` + folder `/ (root)` Save hai? 1–2 min ruko. Folder upload kiya to URL me `/apnashift-waitlist/` jodna padega. |
| Summary me ginti 0 dikhe | `setupSummary` Run kiya tha? (Step 2.5) `Waitlist` me row hai? Sheet refresh karo. |
| Spam rows aa rahi hain | Normal hai — honeypot basic bots rokta hai, sabko nahi. Anjaan numbers wali rows delete karo. Bada launch ho to CAPTCHA lagana padega (abhi scope me nahi). |

Phir bhi atke ho to: pehle `TESTING.md` wala health check karo (URL browser me
kholo → `{"ok":true...}` dikhe to backend sahi hai, dikkat form/hosting me hai).
