# MSSQL Cutover Runbook (Step E — NOT YET APPROVED)

Status: **PREPARED, NOT EXECUTED.** Every command here is read-only or listed
for execution only after explicit approval. Railway PostgreSQL remains
production until Phase 4 is approved and green.

Prepared from verified state (2026-10-17):

- Local `main` = `d293a77` (4 commits ahead of `origin/main`: Phase 1 `ac9381f`,
  Phase 2 `00067de`, data-migration `fea50b7`, this runbook `d293a77` —
  **none pushed**).
- `ApnaShiftDB_migrate` = verified copy of production: 23/23 tables, 42/42 rows
  counts + values (`_audit.mjs`, `_spot_prod.mjs`), app smoke 7/7
  (`_smoke_scratch.mjs`). Date off-by-one bug fixed in `migrate-data-mssql.js`.
- Tests 286/286 (both pg and mssql modes), lint clean, CI green historically.
- Production PG: 23 tables, 42 rows, schema = HEAD minus migration
  `023_pricing_v2` (25 columns across bookings/pricing_rules/pricing_history).

---

## 0. BLOCKING DECISIONS (resolve before any phase)

| # | Decision | Why it blocks | Options |
|---|---|---|---|
| **D1** | **Where does production MSSQL live?** | Today MSSQL = SQLEXPRESS on this laptop (`localhost:14330`). Railway **cannot** reach it, and exposing the laptop is forbidden. | ✅ **CHOSEN: Option A — Azure SQL free offer** (GP serverless, West US 2, $0 at this scale). **TIMING: deferred by user 2026-10-17** — Azure account creation + cost alert ("billing/subscription") will happen in a later phase; Phases 3+ blocked until then. **Further postponed 2026-10-18** (user: abhi nahi, baad me). Interim production = PostgreSQL (Option D posture): $0, no new subscription. Firewall note: Railway static egress = Pro plan only → free path uses a 0.0.0.0/0 rule + strong SQL password + TLS (disclosed, user-approved). |
| **D2** | Final target DB name + tool guard | `migrate-data-mssql.js` only loads into DBs matching `/migrate/i` (safety). Final target needs either (a) keep name containing `migrate` (ugly but works), or (b) an explicit env-gated allowlist added to the tool (small approved edit). | ✅ **RESOLVED: name `ApnaShiftDB_prod` + option (b)** — exact-name allowlist `MIGRATE_ALLOW_TARGET` added to the tool (no wildcards, default behavior unchanged). 2026-10-17 follow-up: same allowlist + `MSSQL_ENCRYPT`/`MSSQL_TRUST_CERT`/`MSSQL_CONNECT_TIMEOUT` knobs extended to the verifiers (`_spot_prod.mjs`, `_audit.mjs`; `_smoke_scratch.mjs` uses `SMOKE_TARGET` + allowlist so `.env` can never silently retarget it). End-to-end rehearsal on local `ApnaShiftDB_prod`: load `VERIFY OK 23/42` → `SPOT-PROD OK` → `SMOKE 7/7` → audit counts 23/23 (expected v2/unique-check deltas only); rehearsal DB dropped. |
| **D3** | Maintenance window | Writes must pause during Phases 1–4 (short: data is 42 rows — window can be ~15 min). | ⏸️ **SUPERSEDED 2026-10-18 by D5 final decision** (Railway winding down pre-launch). No live cutover to schedule until a new host is chosen at launch. Earlier pick "Sun 2026-10-25, 2:00–4:00 AM IST" is **cancelled** — Phases 3–6 deferred to launch. |
| **D4** | When to push `main` | Push triggers full CI → staging → **production deploy** (gates + rollback built in). Phase 0 does this on its own schedule, separate from the window. | Day for Phase 0 |
| **D5** | **Railway hosting continuity (trial expiry)** | Free trial = one-time $5/30 days (banner on 2026-10-17: "13 days or $3.72 left" → ends ≈ 2026-10-31). On expiry the account auto-reverts to the **Free plan = $1/mo credit** < current usage ($1.43 as of 2026-10-18, estimated bill $1.43) → **app + Postgres stop**. Official policy: trial **volumes are deleted 30 days after credit expiry unless the account is upgraded**. | ✅ **FINAL DECISION 2026-10-18 (user): do NOT upgrade — let Railway wind down.** Rationale: app is pre-launch (42 rows, test data); no paid plan/card until real launch. **Consequences accepted:** (1) staging + production go offline when trial credit exhausts (≈Oct 31); (2) trial volumes deleted ~30 days later unless upgraded — **take a final PG dump + local backups before that date**; (3) CI pipeline (staging + production jobs) will start failing once services stop — expected, not a regression. **Revisit at launch:** pick host then (Railway Hobby, Oracle Always Free, Azure, etc.). All MSSQL tooling + verifiers stay committed and unchanged — they run against whatever host is chosen later. |

### D1 options (researched 2026-10-17 — nothing purchased, awaiting pick)

| Option | Cost now | Cost ongoing | Trade-offs |
|---|---|---|---|
| **A. Azure SQL free offer** | $0 | $0 at this size (per-DB: 100k vCore-seconds + 32 GB storage free/month for subscription lifetime, up to 10 DBs) | Managed PaaS, pick West US ≈ Railway `sfo` latency. Caveats: **no SLA** (Microsoft frames it dev/PoC-grade), free tier is for *new* DBs (fits cutover), auto-pause if limits ever hit. Needs Azure account (card for verification, not charged in limits) |
| **B. MSSQL container on Railway** | ~$15–30/mo | same | Same project/region as app (best latency, zero network config). Self-managed backups/patching, Express 10 GB cap (fine for 42 rows), real monthly bill (RAM $10/GB/mo + CPU $20/vCPU/mo) |
| **C. AWS RDS SQL Server Express** | ~$18–20/mo | same | Fully managed backups, us-west-2 ≈ near `sfo`. **No free tier** for accounts after mid-2025 — priciest fit for a 42-row DB |
| **D. Stay on PostgreSQL** | $0 | $0 | Zero risk/effort; all MSSQL work stays committed and verified for a later cutover. Only correct if MSSQL isn't a hard requirement |

Recommendation: **A** (or **D** if MSSQL isn't required). B only if same-region latency outweighs $0; skip C.

---

## PHASE 0 — Pre-cutover (no risk to data; does deploy code)

Push is gated by CI: lint → tests → build → **staging** migrate+deploy+full
smoke → only then **production** migrate+deploy → health/smoke. Any red gate
stops production automatically (workflow `ci-cd.yml`).

- [x] Staging health verified (2026-10-17): env `staging` shows `ApnaShift_App`
      Online (`apnashiftapp-staging-4ecb`) and `diplomatic-solace` Online.
      Findings: `diplomatic-solace` = duplicate legacy API service (its staging
      logs show the same ApnaShift API on port 8080); its **production**
      deployment is Failed *pre-build* ("Deployment does not have an
      associated build") — pre-existing, not caused by this work, and CI only
      ever deploys the one service named by `RAILWAY_STAGING_SERVICE_ID` /
      `RAILWAY_PRODUCTION_SERVICE_ID`.
- [x] At push time: confirm the secrets → `ApnaShift_App` mapping by opening
      any recent Actions run log (`railway up --service <id>` line), and that
      GitHub secrets exist (CI has its own fail-safe guard for this).
      **Confirmed 2026-10-18** — `RAILWAY_STAGING_SERVICE_ID` /
      `RAILWAY_PRODUCTION_SERVICE_ID` both point at `ApnaShift_App`
      (`fd283892`), not `diplomatic-solace`.
- [x] `git push origin main` → watch CI run all jobs green.
      **DONE 2026-10-18** — run `39103177970` (commit `e5db888`) passed all
      8 gates including staging full smoke (16/16) and production health.
- [x] CI applies `023_pricing_v2` to production PG (`db:migrate`, additive only)
      → production schema now = HEAD.
      **DONE 2026-10-18** — production migrate ran 002→023 cleanly, then
      `railway up` deployed, health returned 200. Production `/api/ready` =
      `{"ok":true,"db":"up"}`.
- [ ] Re-run the audit and compare with expectations:

```powershell
# from apnashift-backend
$env:MSSQL_DATABASE='ApnaShiftDB'; railway run node scripts\_audit.mjs
```

Expected after 023: `bookings/pricing_rules/pricing_history` **extra_cols gone**
(column issues drop 5 → 4); remaining4 = identity `default_diffs`
(`commission_history.id`, `notifications.seq`, `pricing_history.id`,
`pricing_rules.id`) — representation-only, acceptable. Counts stay
42 vs 6 (local `ApnaShiftDB` intentionally not loaded).

- [x] Decide D1/D2/D3 (above) — **D2 resolved 2026-10-17** (target
      `ApnaShiftDB_prod` + exact-name allowlist). **D5 final decision
      2026-10-18**: Railway winding down pre-launch (no paid plan until
      launch) → **D3 window cancelled**, Phases 3–6 deferred. **D1 still
      postponed** (Azure account). **Pre-wind-down backup DONE 2026-10-18**:
      production PG dump (pg_dump 18.6, custom format, 184 TOC entries,
      verified with `pg_restore --list`) at
      `backups/apnashift-prod-20261018-130026.dump.zip` (+ raw
      `apnashift-prod-20261018-125905.dump`). Re-dump if prod writes more
      before services stop.

## PHASE 1 — Window start (writes stop, PG untouched)

1. Announce pause to users.
2. Railway dashboard → `ApnaShift_App` (production) → **Pause service**.
   Postgres stays online and becomes the frozen rollback snapshot.
3. Last delta check (prod may have new rows since the scratch copy):

```powershell
$env:MSSQL_DATABASE='ApnaShiftDB_migrate'; railway run node scripts\_audit.mjs
```

If any count differs from the scratch → go to Phase 2 (always re-sync; it is
cheap and idempotent). If identical, still run Phase 2 — it guarantees the
scratch was built from the final frozen state.

## PHASE 2 — Final sync (scratch ← frozen production)

```powershell
# from apnashift-backend — EXACT sequence proven in this repo
# (2026-10-18 note: migrate/_spot ko Railway-form chahiye — Appendix A ka
# "Railway-form gotcha" wrapper pehle padho, warna guard FAIL karega)
$SQ = "C:\Program Files\Microsoft SQL Server\Client SDK\ODBC\170\Tools\Binn\SQLCMD.EXE"
& $SQ -S localhost,14330 -E -Q "IF DB_ID('ApnaShiftDB_migrate') IS NOT NULL DROP DATABASE [ApnaShiftDB_migrate];" -b
& $SQ -S localhost,14330 -E -Q "CREATE DATABASE [ApnaShiftDB_migrate];" -b
& $SQ -S localhost,14330 -E -d ApnaShiftDB_migrate -Q "CREATE USER [apnashift_app] FOR LOGIN [apnashift_app]; ALTER ROLE db_owner ADD MEMBER [apnashift_app];" -b
$env:MSSQL_DATABASE='ApnaShiftDB_migrate'; $env:MIGRATE_ALLOW_REMOTE_SOURCE='1'
railway run node scripts\migrate-data-mssql.js
# expect: VERIFY OK — 23 tables, N rows, counts match.
```

Verify (all read-only):

```powershell
railway run node scripts\_spot_prod.mjs      # values: SPOT-PROD OK
node scripts\_smoke_scratch.mjs             # app: SMOKE-SCRATCH OK 7/7
```

## DONE — Full production → local MSSQL load (2026-10-18, user-requested)

User: "mujhe sara database MSSQL me chahiye; Railway band ho jaye koi dikkat
nahi" — isliye cutover window ke bina, ek complete read-only copy banayi:

- **Target:** `ApnaShiftDB_prod` on `localhost,14330` (SQLEXPRESS01, started
  2026-10-18; service = Auto but machine par kabhi stopped milta hai — pehle
  start karo). Created via `sqlcmd -E` + `apnashift_app` → `db_owner`
  (login non-sysadmin hai, `CREATE DATABASE` khud nahi kar sakta).
- **Tool:** `scripts/migrate-data-mssql.js` (read-only source, schema WITHOUT
  seed, refuses non-empty target). Railway run ab **full `postgres://` URL**
  deta hai aur `PGUSER/PGPASSWORD/PGDATABASE` vars project me hain hi nahi —
  isliye ek temp wrapper (`migrate-prod.ps1`, repo ke bahar) ne URL se PG* vars
  banaye aur `DATABASE_URL` ko `host:port` form me convert kiya (secret sirf
  process env me, kabhi print/CLI nahi).
- **Verify (sab read-only, sab green):**
  1. migrate → `VERIFY OK — 23 tables, 42 rows, counts match`
  2. `_audit.mjs` (`AUDIT_TARGET=ApnaShiftDB_prod`) → 23/23 tables, 42/42
     rows, 0 count-problems, PK/FK parity (schema deltas Appendix C jaisa)
  3. `_spot_prod.mjs` → `SPOT-PROD OK — 42 rows value-level verified`
     (fix: `minimum_fare` real prod config hai, usse defaults-check se hataya
     — row value-match use cover karta hai)

MSSQL copy = production PG ka exact mirror; PG waise bhi 3 copies me safe
(2 Railway env dumps + 1 local dump + ab MSSQL).

## PHASE 3 — Provision final target (D1 + D2)

**BLOCKED on D1** (Azure SQL free account — postponed by user 2026-10-17,
further confirmed 2026-10-18 "abhi ruko"). **Also superseded by D5 final
decision (2026-10-18)** — Railway winding down pre-launch; no live target
to provision until a new host is chosen at launch. Phases 3–6 deferred.

- [ ] Provision chosen host (D1 — your cost approval), note
      `MSSQL_SERVER / MSSQL_PORT / MSSQL_USER / MSSQL_PASSWORD / MSSQL_ENCRYPT`.
- [ ] Create empty DB + login/user with db_owner (provider's console/sqlcmd).
- [ ] Load it with the same proven tool (schema WITHOUT seed — **do not** use
      `npm run db:migrate:mssql` for this target: it includes `002_seed.sql`,
      whose 3 pricing rules would collide with production's 3 rows):

```powershell
$env:MSSQL_SERVER='<host>'; $env:MSSQL_PORT='<port>'; $env:MSSQL_DATABASE='<final-name>'
$env:MSSQL_ENCRYPT='true'   # azure/container typically needs it; local express false
$env:MIGRATE_ALLOW_REMOTE_SOURCE='1'
railway run node scripts\migrate-data-mssql.js
```

  (Needs D2 guard decision if final name lacks `migrate`.)
- [ ] Verify against production exactly as Phase 2 (spot/audit/smoke pointed at
      the final target).

## PHASE 4 — Switch (the actual cutover — needs explicit approval)

⏸️ **DEFERRED 2026-10-18** — no maintenance window until a new production
host exists (D5: Railway winding down pre-launch; D1: Azure postponed).
Kept here as the proven playbook for whenever launch happens.

```powershell
# set vars on production service — password via stdin (never in shell history)
railway variable set DB_DRIVER=mssql --service <PROD_SERVICE_ID> --environment production --skip-deploys
railway variable set MSSQL_SERVER='<host>' --service <PROD_SERVICE_ID> --environment production --skip-deploys
railway variable set MSSQL_PORT='<port>' --service <PROD_SERVICE_ID> --environment production --skip-deploys
railway variable set MSSQL_DATABASE='<final-name>' --service <PROD_SERVICE_ID> --environment production --skip-deploys
railway variable set MSSQL_USER='<user>' --service <PROD_SERVICE_ID> --environment production --skip-deploys
railway variable set MSSQL_ENCRYPT='true' --service <PROD_SERVICE_ID> --environment production --skip-deploys
node -e "require('dotenv').config(); process.stdout.write(process.env.MSSQL_PASSWORD ?? '')" |
  railway variable set MSSQL_PASSWORD --stdin --service <PROD_SERVICE_ID> --environment production --skip-deploys
# then redeploy/restart the service (variable set without --skip-deploys, or dashboard Redeploy)
```

Why this is safe to try: driver selection is `DB_DRIVER` wins, else mssql only
if `MSSQL_USER`+`MSSQL_PASSWORD` set, else pg (`src/db.js:16`). `DATABASE_URL`
stays in place the whole time → rollback never needs a re-add.

Verify immediately:

- [ ] `GET /api/ready` → `{"ok":true,"db":"up"}` (now via MSSQL)
- [ ] Login (your real account), bookings list, notifications, one estimate
- [ ] Tail logs 10 min: no translate errors, no 5xx
- [ ] Drivers app: driver login + available stream (if any driver online)

## ROLLBACK (any failure in Phase 4/5 — target < 2 min)

```powershell
railway variable set DB_DRIVER=pg --service <PROD_SERVICE_ID> --environment production
# (this alone suffices — DB_DRIVER wins over MSSQL_*) …restart happens with deploy
```

- Data loss: only rows written to MSSQL between switch and rollback
  (window is short; ideally zero user writes during observation).
- PG was never modified → it still holds the exact pre-window state.
- Separate concern: **code** rollback (CI deploys) is independent —
  Railway dashboard → Deployments → previous green → Redeploy (per `ci-cd.yml`).

## PHASE 5 — Soak

- [ ] 24–48 h normal operation on MSSQL with PG frozen (no writes).
- [ ] Compare one final time: `_audit.mjs` (prod-PG reference vs target DB
      counts must stay identical while PG is frozen).

## PHASE 6 — Post-cutover (each needs its own approval)

- [ ] Unfreeze decision: keep PG as read-only reference ≥30 days, then decide
      decommission (NOT part of this runbook's execution).
- [ ] Optionally rename scratch/archive laptop DBs.
- [ ] Decide push cadence for future code (CI still migrates PG — harmless).

---

## WIND-DOWN CHECKLIST (D5 — Railway shutoff, pre-launch)

Decided 2026-10-18: no paid plan/card until real launch. Services auto-stop
when trial credit exhausts (≈2026-10-31); trial volumes deleted ~30 days
later unless upgraded. Dates below are targets, not contracts.

- [x] **2026-10-18** Baseline production dumps exist:
      `backups/apnashift-prod-20261018-*.dump(.zip)` (verified TOC=184/195)
      + older local `backups/apnashift-main-20261014-1029.sql`.
- [x] **2026-10-18** Dump script committed: `apnashift-backend/deploy/backup-prod.ps1`
      (password kabhi CLI pe nahi; DATABASE_URL env se). Run:

  ```powershell
  cd apnashift-backend
  railway run --environment production --service ApnaShift_App -- `
    powershell -NoProfile -ExecutionPolicy Bypass -File deploy\backup-prod.ps1
  ```

- [ ] **≈2026-10-30 (services stop se 1 din pehle):** final fresh dump chalao
      (agar Oct 18 ke baad production me koi nayi write hui ho). Naya file
      `backups/apnashift-prod-<date>.dump.zip` banega.
- [ ] **Backup ki dusri copy:** `backups/` folder abhi sirf E: drive pe hai —
      ek copy Google Drive/external disk me daalo (local disk fail = sab
      khatam). Minimum: dono `.dump.zip` + purani `.sql`.
- [ ] **≈2026-11-30 se pehle:** confirm final dump + dusri copy done — uske
      baad Railway trial volumes delete hote hain.
- [x] **2026-10-18** Full production data mirrored to local MSSQL:
      `ApnaShiftDB_prod` (23 tables / 42 rows, audit + value-level verified —
      see "DONE — Full production → local MSSQL load"). Railway band hone par
      bhi data laptop par rahega (ab 4 copies: 2 dumps + old .sql + MSSQL).
- [ ] **Secrets exposure (2026-10-18):** session logs me production
      `DATABASE_URL` password, `GEOAPIFY_API_KEY` **aur `JWT_SECRET`** openly
      dikhe (`railway variable list` table wrap ne redaction bypass kiya —
      aage aise commands avoid karo / JSON me keys lo). Railway
      wind-down ke baad DATABASE_URL ka koi value nahi; launch pe `JWT_SECRET`
      waise bhi **naya banao** (relaunch inventory me likha hai). Geoapify key
      free tier hai — chaho to [my.geoapify.com](https://my.geoapify.com) me
      jaake key rotate kar lo (2 min), Railway dono envs me `GEOAPIFY_API_KEY`
      update karna hoga. Optional.
- [ ] **New host pe relaunch (launch time):** dump restore + `db:migrate` +
      Railway (ya naye host) ke env vars set (names: `DATABASE_URL`,
      `GEOAPIFY_API_KEY`, `JWT_SECRET`, `NODE_ENV`, `TRUST_PROXY`) +
      GitHub secrets update + CI wapas green.
- [ ] **CI expected-red after ≈Oct 31:** Railway jobs fail (services offline)
      — code bug nahi. Deploy-toggle aana chahiye (GitHub Actions variable
      `DEPLOY_DISABLED=true` se staging/prod jobs skip).

### Relaunch env inventory (names only — values Railway dashboard / `.env` se)

App service (staging + production, dono me SAME names, alag values):

| Var | Kya hai |
|---|---|
| `DATABASE_URL` | Postgres connection string (naye host ka, form-B host:port ya full URL) |
| `GEOAPIFY_API_KEY` | geocoding/autocomplete key (free tier) |
| `JWT_SECRET` | auth signing secret — naye host pe **naya banao** purana reuse mat karo |
| `NODE_ENV` | `production` |
| `TRUST_PROXY` | `1` |
| `JWT_EXPIRES_IN` / `BCRYPT_ROUNDS` | optional (defaults chalte hain) |
| `WHATSAPP_*` | abhi khaali (mock/none default) |

GitHub Actions secrets (CI ke liye): `RAILWAY_TOKEN`, `RAILWAY_PROJECT_ID`,
`RAILWAY_STAGING_SERVICE_ID`, `RAILWAY_PRODUCTION_SERVICE_ID`,
`STAGING_DATABASE_URL`, `PRODUCTION_DATABASE_URL`, `STAGING_BASE_URL`,
`PRODUCTION_BASE_URL` (+ `RAILWAY_TOKEN_STAGING`).
GitHub Actions **variable**: `DEPLOY_DISABLED` (`true` = deploy jobs skip).

---

## APPENDIX A — Verifier command reference (all read-only)

```powershell
# counts + schema: production PG vs a local MSSQL DB
$env:MSSQL_DATABASE='ApnaShiftDB'            # or a *migrate* scratch
$env:AUDIT_TARGET='ApnaShiftDB_migrate'      # optional override (guard: ApnaShiftDB or *migrate*)
railway run node scripts\_audit.mjs

# full value-level compare: production PG vs scratch (needs consent flag)
$env:MSSQL_DATABASE='ApnaShiftDB_migrate'; $env:MIGRATE_ALLOW_REMOTE_SOURCE='1'
railway run node scripts\_spot_prod.mjs

# app smoke against local scratch with migrated data
node scripts\_smoke_scratch.mjs

# local-dev-only helpers (no production)
node scripts\_spot.mjs                       # local PG vs MSSQL env DB
node scripts\_smoke.mjs                      # app vs local dev data
railway run node scripts\_schema_compare.mjs # structural diff (schema only)
```

Tool guard recap (`migrate-data-mssql.js`): source localhost **or**
Railway-form + `MIGRATE_ALLOW_REMOTE_SOURCE=1`; target must match
`/migrate/i` **or** `MIGRATE_ALLOW_TARGET` exact name (D2 allowlist); source
SELECT-only; refuses non-empty target (no deletes, ever); per-table `COUNT(*)`
verify + final `VERIFY OK` line.

**Railway-form gotcha (2026-10-18):** `railway run` ab project ko **full
`postgres://` URL** deta hai aur `PGUSER/PGPASSWORD/PGDATABASE` vars set hi
nahi hain. Scripts jo Railway-form (`host:port` + PG* vars) maang hain
(`migrate-data-mssql.js`, `_spot_prod.mjs`) seedha `railway run` se fail
honge — pehle URL se PG* derive karo (repo ke bahar temp wrapper pattern,
jaise `migrate-prod.ps1`/`spot-prod.ps1`): `DATABASE_URL` parse →
`PGUSER/PGPASSWORD/PGDATABASE` set → `DATABASE_URL='<host>:<port>'` → script
run. `_audit.mjs` full URL khud handle karta hai (wrapper nahi chahiye).


## APPENDIX B — CI gates (push → production path)

`ci-cd.yml` on push to `main`: lint → tests (fresh PG service + `db:migrate`)
→ build (docker + frontend mirror check) → staging: migrate → `railway up` →
health → **full E2E smoke** → production: migrate (PRODUCTION_DATABASE_URL,
additive-only) → `railway up` → health + health-smoke → rollback note on any
failure. Production never deploys before staging is green.

**Valid until Railway services stop (~Oct 31, 2026)** — after D5 wind-down,
staging/production Railway jobs will fail (services offline). Expected, not
a code regression. When a new host is picked at launch, rewrite only the
staging/production *deploy* jobs (lint/tests/build still run anywhere);
smoke + health gates stay identical.

## APPENDIX C — Known acceptable schema deltas (target = HEAD)

| Delta | Verdict |
|---|---|
| identity `default_diffs` (4) | Equivalent (PG `nextval` vs MSSQL IDENTITY) |
| UNIQUE 17→14 | Equivalent — prod has 3 duplicate driver constraints on same columns |
| CHECK counts (8 tables, both directions) | Representation differences — def-level review only if byte-parity required |
| v2 extra columns | **Gone after Phase 0** (prod runs `023`) |
| PK 23/23, FK 29/29 (+ per-table), types 12 canonical pairs, nullable diffs 0 | Parity ✓ |

## APPENDIX D — Risks & mitigations

| Risk | Mitigation |
|---|---|
| Translate layer gap on a rarely-used SQL shape | 286/286 tests both modes + staging full smoke before prod deploy; rollback = `DB_DRIVER=pg` |
| Railway ↔ cloud-MSSQL latency | Pick same-region host (Railway is `sfo`); measure `/api/ready` + queries |
| Data drift between sync and switch | Window keeps PG frozen; Phase 2 runs inside the window; audit re-check in Phase 5 |
| Credential exposure | Passwords via `--stdin` / env injection (`railway run`); never echoed, never committed |
| Seed collision on target | Use data tool (seed skipped), never `db:migrate:mssql`, for the data target |
| Laptop dependence | Final target is cloud-hosted (D1); laptop DBs remain archives only |
