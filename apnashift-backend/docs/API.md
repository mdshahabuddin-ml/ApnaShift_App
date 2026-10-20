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
  "vehicle_type": "mini_truck", "helper_needed": false,
  "vehicle_size_tier": "chhota", "goods_weight_kg": 0,
  "item_count": 1, "has_bulky_item": false }
```
New pricing inputs all optional (defaults `chhota`/`0`/`1`/`false` so old clients keep working).
Response `200` (rates `pricing_rules` table se, total nearest Rs 10):
```json
{ "ok": true, "distance_km": 7.15, "vehicle_type": "mini_truck",
  "base_fare": 450, "distance_fare": 160.86,
  "size_charge": 0, "weight_charge": 0, "bulky_charge": 0, "items_charge": 0,
  "helper_charge": 0, "minimum_fare": 450,
  "total": 610, "estimate_min": 550, "estimate_max": 670 }
```
Formula: `raw = base + distance×rate + size_extra + weight_slab + (bulky?100:0) + max(0,item_count-5)×20 + helper`, phir `total = round10(MAX(minimum_fare, raw))`. Weight slabs (kg): `<=100`, `<=300`, `<=500`, `>500` — charges `pricing_rules` se (admin-editable, hardcode nahi).
Ek sheher ka MVP: distance `500 km` se zyada par `400 distance_too_far`
(DB me bhi `CHECK (distance_km <= 500)` backup hai).

## Bookings (role: user)

### POST /api/bookings (token + write limit, payment_method upi/cash)
Body me optional `payment_method` (default `upi`); `online` abhi
`400 unsupported_payment_method`. Creation-time `commission_percent` snapshot
`pricing_rules` (gaadi-type wise) se aata hai — baad me rate badle to purani
bookings unaffected. `GET /:id` me accepted+ par driver `upi_id` milta hai.

### GET /api/admin/bookings?status&from&to&city (paginated)
Body: pickup/drop `{ address, lat, lng }`, `vehicle_type`, `helper_needed`,
`item_description` (mandatory, min 3, max 500 — Items to Shift: kam se kam ek item + quantity, e.g. `2x Bed, 1x Sofa`; khaali par `400 validation_failed`), `scheduled_time` (optional ISO, future me ho —
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

### PATCH /api/bookings/:id/cancel (token, reason required)
Body: `{ "reason": "changed_plan" }` — reason in me se ek:
`wrong_pickup | wrong_drop | wrong_vehicle | changed_plan | duplicate | driver_issue | other`.
Sirf apni booking, sirf `pending`/`accepted` me. Ek atomic UPDATE status +
`cancel_reason`/`cancelled_by='user'`/`cancelled_at` likhta hai (race me driver
advance jeet sakta hai — tab `409 invalid_transition`). `arrived` ke baad,
delivered ya dobara cancel par `409`. Doosre ki booking par `404`.
Response booking me `cancellation: { reason, cancelled_by, cancelled_at }`
aata hai (bina cancel wali me `null`). Row + history delete nahi hoti.
Cancelled trip tracking me `ended` dikhti hai.

### POST /api/bookings/:id/flag-dispute (token, user apni / driver assigned)
Body: `{ "reason": "..." }` (3–500 akshar). Booking par `disputed: true` +
`dispute_reason` set hota hai — paisa/commission auto-change **nahi** hota,
admin review karta hai. Doosre ki booking par `404`.

### GET /api/bookings/:id/rating (token, apni booking)
Apni rating dekho — mili to `200 + rating`, nahi di to `404 not_rated`.
Doosre ki booking par `404`.

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
Accept gate: `commission_due > COMMISSION_DUE_LIMIT` (default Rs 1500) par
`403 commission_limit_exceeded` (+ `outstanding_rs`, `limit_rs`) — pehle hisab
clear karo. Admin assign par ye gate nahi lagta.

### PATCH /api/driver/profile (token, driver — verified zaroori nahi)
Body: `{ "upi_id": "naam@bank" }` (ya `null` = clear). Sirf apna UPI ID;
format `^[\w.-]{2,256}@[a-zA-Z]{2,64}$` (DB backup CHECK 255 cap ke saath).

### GET /api/driver/commission-due (token, driver)
`{ outstanding_rs, outstanding_paise, commission_rs, settled_rs, limit_rs }`.

### POST /api/driver/bookings/:id/flag-dispute (token, driver assigned)
User wale flag jaisa (upar dekho) — apni assigned trip par.
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

### POST /api/driver/bookings/:id/location (token + GPS limit)
Live GPS report — sirf assigned driver, sirf `accepted/arrived/in_transit` me.
Body: `{ "lat": 22.72, "lng": 75.86, "accuracy_m": 12.5, "speed_mps": 8.3, "heading_deg": 90 }`
(`accuracy_m`/`speed_mps`/`heading_deg` optional — heading compass wale devices
bhejte hain, 0..360°; `recorded_at` server lagata hai).
`pending` (unassigned) par `404`, `delivered/cancelled` par `409 tracking_not_active`,
bahut jaldi-jaldi bhejne par `429 too_many_attempts` (+ `Retry-After`).
Har safal post `driver_locations` me row + SSE subscribers ko live event bhejta hai.

## Live tracking (customer + admin)

State machine: `live` (≤60s) / `stale` (60–180s) / `offline` (>180s ya koi point nahi)
 / `ended` (delivered/cancelled). Thresholds env se (`TRACK_STALE_AFTER_MS`,
`TRACK_OFFLINE_AFTER_MS`). Koi ETA invent nahi hota — sirf real points + age.

### GET /api/bookings/:id/location?history=N (role: user, apni booking)
Newest-first N points (default 1, max 50, har point me `lat/lng/accuracy_m/
speed_mps/heading_deg/recorded_at`) + `tracking: { state, last_updated,
age_s, points_count, stale_after_ms, offline_after_ms }` + driver
`{ id, name, vehicle_type, vehicle_number }` (phone kabhi nahi).
Doosre user ki booking par `404`. Thresholds server bhejta hai taaki
frontend badge drift na kare.

### GET /api/bookings/:id/location/stream (role: user, apni booking — SSE)
`Content-Type: text/event-stream`. Pehle `event: snapshot` (latest jaisa payload),
phir har driver post par `event: location`. Auth header se (fetch reader —
EventSource custom header nahi bhej sakta). Frontend stream tootne par
`GET .../location` polling fallback karta hai.

### GET /api/admin/tracking/active?limit=N (role: admin)
Saari `accepted/arrived/in_transit` bookings + newest point (LATERAL) + state +
`counts: { total, live, stale, offline }`. Phone kabhi nahi.

Retention: `driver_locations` rows 30 din baad `npm run tracking:prune` se delete
(`TRACK_RETENTION_DAYS`). Real-time hub in-memory hai (single instance) —
multi-instance par Redis chahiye (limitation dekho).

## Geoapify (maps + geocode + routing — key backend env me)

Key `GEOAPIFY_API_KEY` sirf backend `.env` me rehti hai — HTML/JS me hard-code
mana hai. Tile template runtime me milta hai, geocode/route server-side proxy
hote hain (quota bachane ke liye auth + 100/15min limiter).

### GET /api/geo/config (auth, koi bhi role)
`{ tiles: { template, attribution }, thresholds: { stale_after_ms,
offline_after_ms }, geoapify: { enabled } }`. Key missing ho to `enabled:
false` + OSM fallback template. Frontend (`tracking.html`) isi se Leaflet
tiles lagata hai — driver marker + heading arrow, pickup/drop markers,
Geoapify route polyline (fallback straight line), status badge, last-update time.

### GET /api/geo/autocomplete?text=&limit=&lat=&lng= (auth)
Address suggestions (default 5, max 10; `text` min 3 chars; optional
proximity bias `lat/lng`). Sirf `{ formatted, lat, lng }` milta hai.
`booking.html` pickup/drop fields me datalist suggestions isi se aate hain.

### GET /api/geo/route?pickup_lat=&pickup_lng=&drop_lat=&drop_lng= (auth)
Driving route pickup→drop: `{ distance_m, duration_s, geometry: [{lat,lng}]
(max 200 points) }`. Tracking map polyline isi se banta hai.

## WhatsApp booking (Meta credentials NOT required)

Dialog state machine `wa_conversations` me rehta hai (restart-safe):
`START → PICKUP → DROP → VEHICLE → DATE_TIME → PAYMENT → CONFIRMATION →
BOOKING_CREATED`. Booking wahi `createBookingRow` core mint karta hai
(`booking_source: 'WHATSAPP'`), driver/admin ko wahi SSE events jaate hain,
`booking.created` audit lagta hai. Sirf registered number booking bana sakta
hai; repeat CONFIRM se doosri booking nahi banti (state-consumed pattern).
Provider adapter: `WHATSAPP_PROVIDER` khaali ho to local/test me `mock`
(outbox memory me, tests padhte hain), production me `none` (outbound drop +
log, dialog kaam karta rehta hai). Real Meta Cloud API ke liye
`WHATSAPP_PROVIDER=meta` + token/phone wiring future step hai — webhook shape
(`{ from, text }`) tab bhi nahi badlega.

### GET /api/whatsapp/webhook (public)
Meta verify handshake: `?hub.mode=subscribe&hub.verify_token=&hub.challenge=`.
`WHATSAPP_VERIFY_TOKEN` set nahi hai to hamesha `403` (by design).

### POST /api/whatsapp/webhook (public, rate-limited, no JWT)
Body `{ from, text }` (text max 2000). Galat body → `400 validation_failed`
(bina state chhue). Sahi input par hamesha `200`: `{ ok, reply }`, dialog
poora hote hi `{ ok, booking, reply }` (booking me `booking_source:
'WHATSAPP'`). Admin dashboard bookings list me WhatsApp orders par `WhatsApp`
badge dikhta hai.

## Cash payments, commission & settlements

Paise integer me ginte hain (float kabhi nahi) — half-up rounding, har transaction
par. Commission source: booking creation-time snapshot (`pricing_rules`
per-vehicle rate se copy); delivery isi snapshot se hisab lagata hai —
rate badalne par purani bookings/payments nahi badalti. `pricing_rules` me
rate na mile to `platform_settings.commission.pct` fallback (default 15%).
Frontend me % hard-code karna mana hai — driver ko hamesha server-computed
`estimate` milta hai.

### POST /api/bookings (payment_method upi/cash)
Body me optional `payment_method` (`upi` default, `cash` bhi chalega).
`"online"` abhi `400 unsupported_payment_method` deta hai (gateway nahi hai —
column + CHECK ready hai). Response booking me `payment_method` +
creation-time `commission_percent` snapshot + `payment: null` aata hai
(payment delivery par banta hai).

### Driver: estimates + ledger
- `GET /api/driver/bookings/available` — har pending trip par `estimate:
  { estimated:true, gross_rs, commission_pct, commission_rs, earning_rs }`.
- `GET /api/driver/bookings` — delivered par actual `payment`, baaki par estimate.
- `GET /api/driver/ledger` — summary (cash collected, earning, commission,
  settled, outstanding — sab derived) + 50 payments
  + 50 settlements. Sirf apna data. Stored fast-path: `drivers.commission_due`
  (delivery/settle/adjustment wali same transaction me update hota hai;
  `GET /api/driver/commission-due` aur accept-gate derived outstanding par
  hi chalte hain).
- Delivery (`PATCH .../status` → `delivered`) ek transaction me booking +
  immutable payment (gross=booking price) + audit likhta hai. UPI turant
  `collected`; COD (cash) `pending` rehta hai jab tak driver confirm na
  kare (kabhi auto-confirm nahi).

### Customer: fare + method + status
`GET /api/bookings` me `payment: { method, status, gross_rs }` (commission
fields customer ko nahi dikhte). Cancelled booking par payment `null` —
cancel se ledger kharab nahi hota (payment banti hi delivered par hai).

### Admin (token, role admin)
- `GET /api/admin/commission` — rate + history. `PUT /api/admin/commission`
  `{ "pct": 20 }` — global switch (teenon gaadiyon + fallback ek saath);
  sirf aage ki bookings par; history + audit ek transaction me.
  Per-vehicle fine-tuning: `PUT /api/admin/pricing-rules` me `commission_pct`.
- `GET /api/admin/ledger?driver_id&status` — saari payments (+adjustment deltas).
- `GET /api/admin/payments/:id` — ek transaction + uska adjustment trail.
- `GET /api/admin/driver-balances` — settlement dashboard: trips, cash,
  earning, commission, settled, outstanding (adjustments samet).
- `GET /api/admin/drivers/commission-summary?page&limit` — saare drivers:
  stored `commission_due` + `total_trips`, paginated, highest due first.
- `POST /api/admin/drivers/:id/settle-commission` `{ amount_rs, note?,
  method?='cash', reference_no? }` — stored due ghatao + settlement record
  (same FIFO engine); due se zyada par `409`, negative due impossible.
- `GET /api/admin/settlements?driver_id` — settlement history.
- `POST /api/admin/settlements` `{ driver_id, amount_rs, method,
  reference_no?, notes? }` — amount>0, outstanding se zyada nahi (`409
  settlement_exceeds_outstanding` — yehi double-submit guard hai), reference
  unique (`409 duplicate_settlement`). FIFO oldest-pehle allocate karta hai.
- `POST /api/admin/adjustments` `{ payment_id, commission_delta_paise,
  earning_delta_paise, reason }` — append-only sudhaar (payments rows kabhi
  UPDATE/DELETE nahi hote; koi DELETE endpoint hai hi nahi). Finalized
  (PAID/DISPUTED) week wali payment par `409 settlement_finalized`.

### COD + weekly settlement (Mon–Sun IST, paise me hisab)
- Booking me `cash` = COD, `upi` = Online (UPI). `online` enum abhi bhi
  reserved hai (gateway nahi) — create par `400 unsupported_payment_method`.
- COD delivery par payment `pending` banti hai; driver
  `POST /api/driver/payments/:id/confirm-cash` se haath me mila cash
  confirm karta hai (doosri baar `409 already_confirmed`). UPI ka flow
  purana jaisa (`collected` at delivery). Customer ko `pending` status
  "Pending" dikhta hai (paisa driver ko dena hai).
- `POST /api/admin/settlement-periods/generate` `{ driver_id?,
  week_start? }` — ek driver + ek hafta = ek row, dobara chalane par
  skip (UNIQUE backstop). Sirf `collected` payments ginti hain.
- `GET /api/admin/settlement-periods` (+ driver variant
  `GET /api/driver/settlement-periods` — sirf apna) — status me OVERDUE
  derived hai (beeta hafta + baaki + not frozen).
- `POST /api/admin/settlement-periods/:id/payments` — hafte ke andar
  FIFO, receipt `settlements` me week se linked. PAID final (`409`
  aage), DISPUTED pehle resolve karo.
- `PATCH .../dispute` + `.../resolve` (admin) — sab audit me
  (`settlement.period_*`). Purana global settlement/adjustment flow
  final hafton ko chhoota hi nahi (sync rehta hai).

## Admin (token, role admin)

### GET /api/admin/drivers?status=pending|verified|review (paginated)
`pending` = unverified (rejected samet, wajah saath), `review` = needs_review.

### PATCH /api/admin/drivers/:id/verify | /reject
Reject body: `{ "reason": "..." }` (required). Verify par reason clear.
Har action `audit_logs` me.

### PATCH /api/admin/users/:id/reset-password | /api/admin/drivers/:id/reset-password
Body: `{ "new_password": "..." }` (8–128 akshar). bcrypt hash karke update,
audit me `user.password_reset` / `driver.password_reset` entry. Response me
hash kabhi nahi aata. Unknown id par `404`.

### GET /api/admin/accounts/lookup?phone=X
Password-reset form ke liye user/driver dhoondo (safe fields only).
Galat phone par `400`.

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
PUT body: `{ "vehicle_type": "pickup", "base_rs": 250 }` (kam se kam ek rate).
Editable: `base_rs`, `per_km_rs`, `helper_rs`, `minimum_fare`, `size_small_extra`,
`size_big_extra`, `weight_0_100`, `weight_100_300`, `weight_300_500`, `weight_500_plus`,
`commission_pct`. Current fares — Pickup base/min `250`, Mini Truck `450`,
Mini Tractor `750` (per_km `17.5`/`22.5`/`30` unchanged).
Transaction me update + history row + audit row (teenon atomic — audit fail ho
to rate bhi rollback). Response: `{ ok, rule, history_id }`.
Purani bookings ka `price_rs` snapshot kabhi nahi badalta — naye rates sirf nayi bookings par.
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


## Announcements & maintenance mode (Super Admin)

Sab kuch `announcements` table me (DDL: `db/mssql/005_announcements.sql` +
`006_announce_notify_before.sql` — `notify_before_minutes`).
"Active right now" DERIVED hai — `published` AND (`start_at` NULL ya <= abhi)
AND (`end_at` NULL ya > abhi). Isliye expiry ka koi background job nahi;
maintenance block bhi window close hote hi AUTOMATICALLY lift ho jaata hai.

### GET /api/announcements/active (public, rate-limited)
`?audience=user|driver` — universal (`all`) rows hamesha, plus apni audience.
Response: `{ ok, served_at, maintenance: { blocked, message, until }, items[] }`
`items[]` me `severity` (info|warning|critical|maintenance), `start_at`/`end_at`
(UTC ISO, null = open-ended), `show_banner`, `block_message` etc.
`until = null` ka matlab at-least-ek indefinite maintenance row active hai.
Clients ko `served_at` se expire karna chahiye (server clock source of truth).

### Admin CRUD (sirf `super_admin`, audit `announcement.*`)

- `GET /api/announcements?page&limit&status&audience` — list + `total` +
  `fcm_configured` flag (FCM creds ka status batata hai).
- `POST /api/announcements` — create. Required: `title`, `body`, `severity`,
  `audience`. Optional: `status` (default `draft`), `start_at`/`end_at`
  (ISO-8601 WITH offset — client apna IST wall-clock offset ke saath bheje),
  `timezone` (default `Asia/Kolkata`), `show_banner`, `maintenance_mode` +
  `block_message` (maintenance ke liye block_message ZAROORI hai),
  `push_enabled`, `push_title`, `push_body`, `push_scheduled_at`,
  `notify_before_minutes` (0..10080, nullable — ADVANCE NOTIFICATION).
  Schedule resolution (WRITE time par, dispatcher unchanged):
  explicit `push_scheduled_at` WINS warna `start_at − notify_before_minutes`
  (jab dono ho) warna null. `status:'published'` + `push_enabled:true` →
  push turant arm (`push_status:'scheduled'`, derived schedule na mile to
  turant).
- `GET /api/announcements/:id` — single.
- `PATCH /api/announcements/:id` — partial update (sirf bheje hue fields).
  Status side-effects:
  - `->deactivated`: `deactivated_at` stamp + pending scheduled push CANCEL.
  - `->published`: `deactivated_at` clear + push re-arm (agar push_enabled).
  - `->draft`: pending scheduled push CANCEL.
  - `push_enabled:false` jab push scheduled ho → cancel.
  - `start_at`/`notify_before_minutes` change jab push ABHI BHI `scheduled`
    ho aur payload me explicit `push_scheduled_at` NA ho → derived schedule
    recalc (`start_at − N`). Sent/failed push kabhi restart nahi hote.
  - `retry_push:true` (sirf published + push_enabled): `push_log` ke SIRF
    `failed` rows delete (sent rows safe = kabhi duplicate nahi),
    counters reset, push re-arm immediate.
- `GET /api/announcements/:id/push` — delivery report: counters + log counts +
  last 50 rows + `fcm_configured`.
- `POST /api/announcements/:id/push/run` — dispatcher abhi chalao (30s ticker
  ka intezaar mat karo). Bina FCM creds: `{ dispatch: { skipped:
  'awaiting_credentials' } }`.

### Maintenance enforcement (HTTP 423)

Active `maintenance_mode` row hone par, IN sab par
`423 { ok:false, error:'maintenance_active', message:<block_message>, until }`:
`POST /api/bookings`, `POST /api/bookings/estimate-price`, driver
`accept`/`decline`/`status`, aur WhatsApp booking creation (createBookingRow
choke point — WhatsApp reply maintenance message deta hai, conversation state
reset nahi hota).

### FCM push (gated)

`FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY` (env) set hone tak
dispatcher `{skipped:'awaiting_credentials'}` return karta hai — koi row
touch nahi hoti. Dispatch crash-safe hai: `announcement_push_log` ka
UNIQUE (announcement, role, owner, token) dedupe + `scheduled->sending` CAS
claim; restart par already-sent rows skip ho jaati hain. Dead tokens FCM 404/410
par `device_tokens` se auto-delete.


## App updates & release notifications (Super Admin)

Sab kuch `app_releases` + `app_release_push_log` tables me (DDL:
`db/mssql/007_app_releases.sql` — MSSQL-only, koi PG migration nahi).
"Latest release" DERIVED hai — `status='published'` ki sabse nayi row
(`published_at DESC`); retire karne ke liye `archived` kar do, koi job nahi.

### GET /api/app-updates/latest?version=1.0.0 (public, rate-limited)

App startup/resume par version check. Response:
`{ ok, served_at, installed_version, action, latest_version, build,
min_supported_version, mandatory, update_url, priority, release_notes }`
`action`: `none` (up-to-date / no published release / unknown installed
version), `optional` (nayi version hai), `required` (mandatory release ya
`installed < min_supported_version`). `update_url` hamesha `https://`
(official Play Store listing / verified APK page) — backend kabhi APK
serve nahi karta. FCM creds ya Firebase config yahan SECRETS kabhi nahi.

### Admin CRUD (sirf `super_admin`, audit `app_release.*`)

- `GET /api/app-updates?page&limit&status` — list + `fcm_configured` flag.
- `POST /api/app-updates` — create. Required: `version` (strict `x.y.z`),
  `release_notes`, `audience` (all|users|drivers), `priority`
  (low|normal|high). Optional: `build`, `min_supported_version`
  (<= version), `mandatory` (bool), `update_url` (https-only), `status`
  (default `draft`), `push_enabled`, `push_title`, `push_body`,
  `push_scheduled_at` (ISO-8601 WITH offset). `status:'published'` →
  `published_at` stamp + push arm (agar `push_enabled`, schedule na mile to
  turant).
- `GET /api/app-updates/:id` — single.
- `PATCH /api/app-updates/:id` — partial update. Status side-effects:
  - `->archived`: pending scheduled push CANCEL.
  - `->published`: `published_at` stamp + push re-arm (agar push_enabled).
  - `->draft`: pending scheduled push CANCEL.
  - `push_enabled:false` jab push scheduled ho → cancel.
  - `retry_push:true` (sirf published + push_enabled): `push_log` ke SIRF
    `failed` rows delete (sent rows safe = kabhi duplicate nahi), counters
    reset, push re-arm immediate.
- `GET /api/app-updates/:id/push` — delivery report: counters + log counts +
  last 50 rows + `fcm_configured`.
- `POST /api/app-updates/:id/push/run` — dispatcher abhi chalao.

### Mandatory enforcement (HTTP 426)

App `X-App-Version` header bhejta hai. `update_required` action wali version
hone par, IN sab par `426 { ok:false, error:'update_required',
latest_version, min_supported_version, update_url, message }`:
`POST /api/bookings`, `POST /api/bookings/estimate-price`, driver
accept/decline/status. Header absent/garbage ho to request chalti hai
(website/WhatsApp flows unaffected) — enforcement SERVER par hai, client
dialog sirf UX. Published-release cache 60s (test me 0), writes invalidate
karte hain.

### FCM push (gated)

Announcements jaisa hi crash-safe pattern: `app_release_push_log` ka
UNIQUE (release, role, owner, token) dedupe (insert-before-send — restart
par kabhi double nahi), `scheduled->sending` CAS claim, dead-token auto
prune, failed-only retry. 30s ticker `server.js` se start hota hai
(`startReleaseTicker`). Bina `FCM_*` creds: dispatcher
`{skipped:'awaiting_credentials'}` — rows untouched (staged activation:
creds aate hi on).
