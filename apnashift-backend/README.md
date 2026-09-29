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
- `PATCH /api/bookings/:id/cancel` — sirf pending/accepted me.
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
