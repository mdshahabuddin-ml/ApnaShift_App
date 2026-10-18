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
      postponed** (Azure account). **Action item before ≈Nov 30** (30 days
      after trial credit exhausts): take final PG dump + local backups so
      trial-volume deletion cannot lose anything.

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
`/migrate/i`; source SELECT-only; refuses non-empty target (no deletes, ever);
per-table `COUNT(*)` verify + final `VERIFY OK` line.

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
