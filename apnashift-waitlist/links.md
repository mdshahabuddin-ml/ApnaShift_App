# ApnaShift — Tracking Links (`?src=`) Guide

Form ka link **ek hi** hai. Har jagah alag link mat banao — usi link ke aage
`?src=CODE` laga do. Backend (Code.gs) ye code padhkar `Source` column me
likhta hai, aur Summary sheet me source-wise ginti khud ban jati hai.

## Link kaise banayein

1. Apna form ka link lo, example: `https://<tumhara-form-link>/index.html`
2. Uske aage `?src=CODE` jodo. Example: `https://<tumhara-form-link>/index.html?src=college`
3. CODE ke rules:
   - Chhota, English lowercase, bina space — space ki jagah `-` use karo.
   - Max ~30 akshar (form 60 tak rakhta hai, par chhota best hai).
   - Har jagah ke liye alag CODE (neeche list).
4. Agar link me pehle se `?` ho (example: `...?x=1`), to `?src=` ki jagah `&src=` use karo.

Bina `?src=` khula link `direct` me gina jata hai.

## 7 example links (copy-paste karke domain badlo)

| Kahan bhejna hai | CODE | Poora link |
|---|---|---|
| WhatsApp status | `status` | `https://<tumhara-form-link>/index.html?src=status` |
| College/hostel group | `college` | `https://<tumhara-form-link>/index.html?src=college` |
| Society/apartment group | `society` | `https://<tumhara-form-link>/index.html?src=society` |
| Facebook local group | `facebook` | `https://<tumhara-form-link>/index.html?src=facebook` |
| Friends/family personal | `friends` | `https://<tumhara-form-link>/index.html?src=friends` |
| Instagram bio/story | `instagram` | `https://<tumhara-form-link>/index.html?src=instagram` |
| Pamphlet/QR (offline) | `flyer` | `https://<tumhara-form-link>/index.html?src=flyer` |

outreach.md ke har template me `{LINK}` ki jagah upar wali table ka matching
link paste karo (example: college wale message me `?src=college` wala link).

## Summary sheet me source-wise count kaise dekhein

1. Apps Script me `setupSummary` ek baar Run karo (TESTING.md dekho).
2. Sheet me `Summary` tab kholo.
3. `Source-wise count (auto)` table dekho — har source aur uski ginti
   khud banti hai (QUERY formula se, `Waitlist` ke `Source` column se).
4. `direct` = bina `?src=` aayi entries. Ye normal hai.
5. Numbers turant na badle to Sheet refresh karo, 1 min ruko.
6. Hafte me ek baar compare karo: kaunsi jagah se zyada waitlist aayi,
   agli outreach wahi zyada karo.
