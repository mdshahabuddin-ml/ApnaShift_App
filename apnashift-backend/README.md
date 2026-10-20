# ApnaShift Backend (MVP, ek sheher)

On-demand shifting API: pickup, mini truck, mini tractor. Stack: Node 20,
Express, Postgres (pg, no ORM), JWT, bcrypt, zod.

## Setup

1. `.env.example` ko `.env` me copy karo, values bharo (`DATABASE_URL`,
   `JWT_SECRET` zaroori — bina JWT ke server start nahi hoga).
2. `npm install`
3. `npm run db:migrate` (tables + pricing seed).
4. `npm run dev` (ya `npm start`).
5. Test: `npx vitest run`. DB wale auth tests ke liye
   `TEST_DATABASE_URL=postgres://.../apnashift_test npx vitest run`.

## Endpoints (abhi tak)

- `GET /api/health` — DB ke bina (uptime check).
- `GET /api/ready` — DB check (`SELECT 1`).
- `POST /api/auth/register` — user (name, phone, password min 8).
- `POST /api/auth/login` — phone+password, JWT `{ id, role }`.
- `GET /api/auth/me` — Bearer token par profile.
- `POST /api/drivers/register` — driver (vehicle_type:
  `pickup|mini_truck|mini_tractor`), `is_verified=false` se start.
- `POST /api/admin/login` — admins table.
- `POST /api/bookings/estimate-price` — public, rate limited.
  Body: `{ pickup: {lat,lng}, drop: {lat,lng}, vehicle_type, helper_needed }`.
  Rates `pricing_rules` table se. Total nearest Rs 10, range total ±10%.
- `POST /api/bookings` — user, price server ginata hai (client price ignore).
- `GET /api/bookings` (paginated) / `GET /api/bookings/:id` — apni bookings.
- `PATCH /api/bookings/:id/cancel` — sirf pending/accepted me, reason required
  (`wrong_pickup|wrong_drop|wrong_vehicle|changed_plan|duplicate|driver_issue|other`).
- Live tracking: `POST /api/driver/bookings/:id/location` (driver, active trip),
  `GET /api/bookings/:id/location` + `/location/stream` SSE (user, apni booking),
  `GET /api/admin/tracking/active` (admin). Frontend: `tracking.html` (customer),
  driver dashboard me location sharing, admin dashboard me Tracking tab.
  Purani GPS rows: `npm run tracking:prune` (30 din retention).
- Cash payments + commission + settlement: delivery par immutable payment
  (`collected`), server-side paise math, configurable commission
  (`GET|PUT /api/admin/commission`), driver ledger (`GET /api/driver/ledger`),
  admin settlement dashboard (`GET /api/admin/driver-balances`,
  `GET|POST /api/admin/settlements`, `GET /api/admin/ledger`,
  `POST /api/admin/adjustments`). Frontend: driver hisab card, admin Settlement tab.
- Driver (verified): `GET /api/driver/bookings/available`,
  `PATCH /api/driver/bookings/:id/accept` (atomic — race me ek jeetega),
  `PATCH /api/driver/bookings/:id/status` (accepted→arrived→in_transit→delivered),
  `GET /api/driver/bookings`, `GET /api/driver/earnings/weekly`.
- Ratings: `POST /api/bookings/:id/rating` (user, delivered + ek baar),
  `GET /api/drivers/:id/ratings` (public, phone nahi),
  `GET /api/admin/drivers/flagged` (admin — avg<3.0 wale, ban nahi).
- Admin: `GET /api/admin/drivers?status=`, `PATCH .../verify|reject`,
  `GET /api/admin/bookings` (status/date/city + totals),
  `PATCH /api/admin/bookings/:id/assign`, `GET|PUT /api/admin/pricing-rules`
  (+ `/history`), `GET /api/admin/stats`. Sab actions `audit_logs` me.
- DB migrate: `npm run db:migrate` (schema + `db/migrations/*` + seed).

Phone format: 10 digit Indian mobile (`^[6-9]\d{9}$`, +91/space chalega —
normalize hota hai). Galat phone ho ya password, jawab ek jaisa:
`invalid_credentials`.

## Google Distance provider par switch (baad me)

Default `haversine` hai (free, key nahi chahiye — seedhi line x 1.3).
Google Distance Matrix par jaane ke liye:

1. Google Cloud Console me project banao, **billing on** karo (Matrix paid API hai).
2. **Distance Matrix API enable** karo, **API key** banao.
3. Key par HTTP-referrer/IP restriction lagao (key leak ho to bill na phate).
4. `.env` me set karo:
   ```
   DISTANCE_PROVIDER=google
   GOOGLE_MAPS_KEY=tumhari-key
   ```
5. Server restart karo. Pehla estimate request Google se distance lega.
6. Key ke bina `DISTANCE_PROVIDER=google` par request fail hogi (500) —
   isliye key lagaye bina env mat badlo. Wapas aana ho to
   `DISTANCE_PROVIDER=haversine` karke restart karo, key hatane ki zaroorat nahi.

## Local development (post-Railway: laptop + local MSSQL)

Railway wind-down (D5, ≈Oct 2026) ke baad sab kuch local chalta hai —
backend laptop par, DB local SQL Server (`LAPTOP-0KTPRBS3\SQLEXPRESS01` /
`ApnaShiftDB`). `DB_DRIVER` MSSQL creds dekh kar khud `mssql` select karta hai
(koi Railway URL/PG kabhi use nahi hota).

### Backend

```powershell
cd apnashift-backend
node src/server.js        # port 3000; ya npm run dev
```

### Website (browser)

- `http://localhost:3000/` — Express `public/` se seedha serve hoti hai.
- Base URL sirf **`api-config.js`** se aata hai (single source dono mirrors me):
  localhost/file → `http://localhost:3000`, baaki host (LAN IP, tunnel, prod)
  → same-origin `""` (page jis origin par serve ho, `/api/` bhi wahi se).
- Koi HTML page koi production URL hardcode nahi karta.

### Flutter app

- Android emulator: **bina flag ke** — debug build default
  `http://10.0.2.2:3000` hai.
- Real phone (same WiFi):
  `flutter run --dart-define=API_BASE_URL=http://<laptop-LAN-IP>:3000`
- Release build: `API_BASE_URL` define **zaroori** hai — warna app
  fail-fast karta hai (`api_base_url_missing`), galat URL par chup-chaap
  nahi jata. Hardcoded production URL app me hai hi nahi.
- Laptop ka LAN IP router me DHCP-reserve kar lo, warna IP change hone par
  phone builds toot jayenge.

### Kisi ko door se test karwana (free — Cloudflare quick tunnel)

```powershell
cloudflared tunnel --url http://localhost:3000
```

- Mila `https://<random>.trycloudflare.com` — website wahi se khulti hai
  (same-origin, koi config nahi), Flutter:
  `flutter run --dart-define=API_BASE_URL=https://<random>.trycloudflare.com`
- Tunnel sirf Node API (:3000) expose karta hai — SQL Server port kabhi mat
  kholo. Band = Ctrl+C.

### Windows Firewall (sirf ek baar, LAN/phone ke liye)

```powershell
New-NetFirewallRule -DisplayName "ApnaShift dev (TCP 3000)" -Direction Inbound -Protocol TCP -LocalPort 3000 -Profile Private -Action Allow
```

### CI note

Railway band hone ke baad deploy jobs ke liye GitHub variable
`DEPLOY_DISABLED=true` set karo (details: `docs/MSSQL_CUTOVER.md`
wind-down checklist) — warna push par expected-red CI confuse karegi.
