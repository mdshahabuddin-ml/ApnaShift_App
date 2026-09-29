# ApnaShift API (MVP)

Base URL (local): `http://localhost:3000`. Sab responses JSON. Har error ka
shape: `{ "ok": false, "error": "<code>" }` — kabhi stack/hash/token bahar nahi.

## Common rules

- **Auth:** `Authorization: Bearer <JWT>` header. Token me `{ id, role }`
  hota hai (role: `user` | `driver` | `admin`), expiry 7 din.
- **vehicle_type** (API me): `pickup` | `mini_truck` | `mini_tractor`.
- **Phone:** 10 digit Indian mobile (`^[6-9]\d{9}$`); `+91`/space chalega,
  normalize hota hai. Galat phone ho ya password — jawab ek jaisa:
  `401 invalid_credentials`.
- **Doosre ka data:** apni nahi to `404 not_found` (403 nahi — existence leak
  nahi karni). Galat role par `403 forbidden`. Bina token `401`.
- **Pagination:** `?page=1&limit=20` (limit max 100). Jawab me
  `page, limit, total` saath aate hain.
- **Rate limits (per IP):** global 100/15min (`/api`), login/register 10/15min,
  estimate + booking-create + rating 60/15min. Zyada par `429 too_many_attempts`.
- **IDs:** galat UUID par `404 not_found` (500 nahi).

## Health

### GET /api/health (public, DB nahi chhoota)
Response `200`: `{ "ok": true, "service": "apnashift-backend", "time": "..." }`

### GET /api/ready (public, DB check)
Response `200`: `{ "ok": true, "db": "up" }`. DB down to `500 server_error`.

## Auth

### POST /api/auth/register (user, rate limited)
Body: `{ "name": "Rahul Sharma", "phone": "98765 43210", "password": "password123" }`
(password min 8). Response `201`:
```json
{ "ok": true, "token": "<JWT>",
  "user": { "id": "<uuid>", "name": "Rahul Sharma", "phone": "9876543210", "role": "user" } }
```
Duplicate phone: `409 phone_taken`. Galat input: `400 validation_failed` + `details`.

### POST /api/auth/login (rate limited)
Body: `{ "phone": "9876543210", "password": "password123" }`. Phone jis table
me mile (users → drivers → admins), us role ka token. Response `200`:
```json
{ "ok": true, "token": "<JWT>",
  "user": { "id": "<uuid>", "name": "Rahul Sharma", "phone": "9876543210", "role": "user" } }
```
Driver ke user me extra: `vehicle_type, vehicle_number, is_verified`.
Galat phone/password: `401 invalid_credentials` (dono me same).

### GET /api/auth/me (token)
Response `200`: `{ "ok": true, "user": { ...apna profile... } }`.
Bina/galat token: `401 missing_token` / `invalid_token`.

### POST /api/drivers/register (rate limited)
Body:
```json
{ "name": "Dev Driver", "phone": "9123456789", "password": "password123",
  "vehicle_type": "mini_truck", "vehicle_number": "MP09AB1234" }
```
Naya driver `is_verified: false` se start (tab tak bookings nahi milengi).
Response `201`: token (role `driver`) + user.

### POST /api/admin/login (rate limited)
Body: `{ "phone": "...", "password": "..." }` (admins table, manual insert).
Response `200`: token (role `admin`).

## Estimate (public)

### POST /api/bookings/estimate-price (rate limited)
Body:
```json
{ "pickup": { "lat": 22.7196, "lng": 75.8577 },
  "drop": { "lat": 22.75, "lng": 75.9 },
  "vehicle_type": "mini_truck", "helper_needed": false }
```
Response `200` (rates `pricing_rules` table se, total nearest Rs 10):
```json
{ "ok": true, "distance_km": 7.15, "vehicle_type": "mini_truck",
  "base_fare": 600, "distance_fare": 160.86, "helper_charge": 0,
  "total": 760, "estimate_min": 680, "estimate_max": 840 }
```
Ek sheher ka MVP: distance `500 km` se zyada par `400 distance_too_far`
(DB me bhi `CHECK (distance_km <= 500)` backup hai).

## Bookings (role: user)

### POST /api/bookings (token + write limit)
Body: pickup/drop `{ address, lat, lng }`, `vehicle_type`, `helper_needed`,
`item_description` (optional, 500), `scheduled_time` (optional ISO, future me ho —
past date par `400 validation_failed`).
**Price server ginata hai** — body me price bhejo to ignore hoga.
Distance `500 km` se zyada par `400 distance_too_far` (koi row nahi banti).
Response `201`: `{ "ok": true, "booking": { "id": "...", "status": "pending",
"distance_km": 7.15, "price_rs": 760, ... } }`.

**Idempotency-Key (optional, retry-safe):** header `Idempotency-Key: <key>`
bhejo (`A-Za-z0-9_-`, 1–64 chars). Scope per-user hai.
Pehli baar `201`, same key + same payload dobara bhejo to `200` + wahi booking
(nayi row nahi). Same key + alag payload par `422 idempotency_conflict`.
Galat format par `400 invalid_idempotency_key`. Header na bhejo to har
request nayi booking banata hai (purana flow).

### GET /api/bookings?page=1&limit=20 (token)
Apni bookings, nayi pehle. Response: `{ ok, page, limit, total, bookings: [] }`.

### GET /api/bookings/:id (token)
Apni booking. Doosre ki ho to `404`.

### PATCH /api/bookings/:id/cancel (token)
Sirf `pending`/`accepted` me. Response: booking (`cancelled`). Nahi to `409`.

### POST /api/bookings/:id/rating (token + write limit)
Body: `{ "stars": 5, "comment": "time par aaya" }` (stars 1–5 int).
Sirf apni **delivered** booking, ek baar. Response `201`:
`{ "ok": true, "rating": { "id": "...", "booking_id": "...", "stars": 5, "comment": "...", "created_at": "..." } }`.
Delivery se pehle: `409 not_delivered`. Dobara: `409 already_rated`.

## Driver public

### GET /api/drivers/:id/ratings (public)
Response `200`:
```json
{ "ok": true,
  "driver": { "id": "...", "name": "Dev", "vehicle_type": "mini_truck", "avg_rating": 4, "total_trips": 2 },
  "average": 4, "count": 2,
  "comments": [{ "stars": 5, "comment": "time par aaya", "created_at": "..." }] }
```
Phone number kahin nahi aata (users table query hoti hi nahi).

## Driver (token, role driver, verified)

Unverified driver: `403 driver_unverified`. Status machine:
`pending → accepted → arrived → in_transit → delivered` (+`cancelled` user se).
`delivered_at` sirf `delivered` par set hota hai (baaki sab par `null`);
DB me invariant bhi hai (`delivered <=> delivered_at NOT NULL`).

### GET /api/driver/bookings/available (paginated)
`pending` + apni gaadi type, purani pehle.

### PATCH /api/driver/bookings/:id/accept
Atomic — do driver saath dabayein to ek ko `200`, doosre ko `409 already_accepted`.
Galat gaadi type par `404`.

### PATCH /api/driver/bookings/:id/status
Body: `{ "status": "arrived" }` (sirf agla step). Chhalang par `409 invalid_transition`.
`delivered` par response me `delivered_at` (abhi ka time) aata hai, pehle `null` rehta hai.

### GET /api/driver/bookings (paginated)
Apni history, nayi pehle.

### GET /api/driver/earnings/weekly
`{ "ok": true, "period": "7d", "completed_count": 1, "earnings_rs": 760 }`
(`delivered_at` pichle 7 din me — `updated_at` nahi, jo har edit par badalta hai).

## Admin (token, role admin)

### GET /api/admin/drivers?status=pending|verified|review (paginated)
`pending` = unverified (rejected samet, wajah saath), `review` = needs_review.

### PATCH /api/admin/drivers/:id/verify | /reject
Reject body: `{ "reason": "..." }` (required). Verify par reason clear.
Har action `audit_logs` me.

### PATCH /api/admin/drivers/:id/deactivate | /reactivate
`is_active` FALSE/TRUE karta hai. Deactivated driver login kar sakta hai par
`403 driver_inactive` milega (bookings/accept/status blocked) aur admin assign
`409 driver_unavailable` dega. Har action `audit_logs` me.

### GET /api/admin/drivers/flagged
needs_review drivers (avg<3.0, 5+ ratings). Ban nahi hota — manual review ke liye.

### GET /api/admin/bookings?status&from&to&city (paginated)
`from`/`to` ISO dates (created_at), `city` address me search.
Response me `total` + `revenue_rs` (cancelled excluded) + rows (user/driver naam samet).

### PATCH /api/admin/bookings/:id/assign
Body: `{ "driver_id": "<uuid>" }`. Sirf `pending` → `accepted`.
Driver verified+active aur gaadi match honi chahiye
(`409 driver_unavailable`, `400 vehicle_mismatch`). Audit me.

### GET /api/admin/pricing-rules | PUT | GET /history
PUT body: `{ "vehicle_type": "pickup", "base_rs": 400 }` (kam se kam ek rate).
Transaction me update + history row + audit row (teenon atomic — audit fail ho
to rate bhi rollback). Response: `{ ok, rule, history_id }`.
Verify/reject/assign me audit best-effort hai (audit fail ho to bhi main
action success rehta hai).

### GET /api/admin/stats
```json
{ "ok": true,
  "today": { "bookings": 2, "completed": 1, "cancelled": 0, "revenue_rs": 760 },
  "week": { ... }, "total": { ... },
  "drivers": { "verified_active": 3 } }
```
Revenue sirf delivered ka. `bookings`/`cancelled` ginti `created_at` se (kab bani),
`completed`/`revenue` `delivered_at` se (kab deliver hui).

## Deploy notes (security)

- `.env` me `JWT_SECRET` (min 32 chars, bina iske start nahi hoga),
  `DATABASE_URL`, `CORS_ORIGIN` (prod me `*` mat rakho — apna domain likho).
- Proxy (Render/Heroku/Nginx) ke peeche ho to `TRUST_PROXY=1`, nahi to khaali
  rakho (galat trust = rate limit bypass).
- Google distance chahiye to `DISTANCE_PROVIDER=google` + `GOOGLE_MAPS_KEY`
  (bina key ke request fail hogi). Default `haversine` free hai.
