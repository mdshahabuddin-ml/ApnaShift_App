# ApnaShift_APP

On-demand shifting (Pickup, Mini Truck, Mini Tractor) — one city MVP.
`apnashift-backend/` (Express + Postgres, frontend ko `public/` se serve karta hai),
`apnashift-frontend/` (source pages), `apnashift-waitlist/` (alag static page).

> App-level API docs: `apnashift-backend/docs/API.md` + `apnashift-backend/openapi.yaml`.
> Ye README repo + **CI/CD pipeline** ke liye hai.

## CI/CD pipeline (`.github/workflows/ci-cd.yml`)

```
GitHub push (main)
  -> lint (npm run lint)
  -> tests (vitest, real Postgres 15 service)
  -> build (public/ mirror check + docker build)
  -> [STAGING]  migrate -> railway up -> /health + /ready -> smoke FULL
  -> [PROD]     migrate -> railway up -> /health + /ready -> smoke HEALTH-ONLY
  -> fail? -> rollback instructions (manual redeploy, DB touch nahi)
```

Har job fail hone par `::error::CI FAIL/SMOKE FAIL/DEPLOY RUKA...` message aata hai —
log me seedha pata chalta hai kaunsa gate toota aur local me kaise reproduce karein.

| Job | Kya karta hai | Fail par |
|---|---|---|
| `lint` | `npm run lint` | Push aage nahi badhta |
| `test` | Test DB migrate + `vitest run` (mssql excluded — neeche note) | Push aage nahi badhta |
| `build` | `public/` mirror sync check + `docker build` | Push aage nahi badhta |
| `deploy-staging` | Staging DB migrate (additive) + `railway up` (staging env) | Required deploy secrets missing ho to job safe-skip (warn), warna prod ko haath nahi lagta |
| `verify-staging` | 5 min tak `/api/health` + `/api/ready` (`"db":"up"`) | Prod deploy NAHI hota |
| `smoke-staging` | Admin banakar **FULL E2E** (neeche) | Prod deploy NAHI hota |
| `deploy-production` | Sirf `main` + staging-green ke baad; prod migrate + `railway up` | — |
| `verify-production` | `/health` + `/ready` + smoke **HEALTH-ONLY** (koi test data nahi) | Rollback instructions |
| `rollback-note` | `failure()` par manual rollback steps print karta hai | — |

**Tests map (requirement coverage):** health+ready `tests/health.test.js`,
auth `tests/auth.test.js`, booking `tests/bookings.test.js`,
driver assignment `tests/booking-dispatch.test.js`,
location posts `tests/tracking.test.js`, live tracking `tests/booking-tracking.test.js`,
enterprise `tests/enterprise.test.js`, DB connectivity `/api/ready` + `tests/audit*.test.js`.
`tests/mssql.test.js` CI me excluded hai — usko real SQL Server chahiye jo
GitHub runners par nahi hota (known env gap, app code se unrelated).

## GitHub Secrets (repo Settings -> Secrets and variables -> Actions)

| Secret | Kaunsa |
|---|---|
| `RAILWAY_TOKEN` | Railway CLI deploy token |
| `RAILWAY_PROJECT_ID` | Railway project id |
| `RAILWAY_STAGING_SERVICE_ID` | Staging backend service id |
| `RAILWAY_PRODUCTION_SERVICE_ID` | Production backend service id |
| `STAGING_DATABASE_URL` | Staging Postgres URL — **sirf** `db:migrate` + `create-admin` ke liye |
| `PRODUCTION_DATABASE_URL` | Production Postgres URL — **sirf** `db:migrate` ke liye |
| `STAGING_BASE_URL` | `https://<staging>.up.railway.app` (trailing slash nahi) |
| `PRODUCTION_BASE_URL` | `https://apnashiftapp-production.up.railway.app` |

Koi secret kabhi code/`.env`/image me commit nahi hota (`.env` gitignored hai —
`git ls-files | grep '\.env$'` khaali aana chahiye; Dockerfile me `ENV` se koi
secret set nahi hota).

## Railway variables (dashboard -> service -> Variables)

Staging aur production me **alag-alag values**: `DATABASE_URL` (postgres plugin),
`JWT_SECRET` (lambe random, dono env me different), `JWT_EXPIRES_IN=7d`,
`GEOAPIFY_API_KEY`, `NODE_ENV=production`, `TRUST_PROXY=1`, `BCRYPT_ROUNDS=12`.
`WHATSAPP_*` abhi khaali (mock/none default). `DATABASE_URL` kabhi GitHub
Secret se app me inject nahi hota — Railway plugin khud deta hai; Secrets wale
URLs sirf CI ke migrate/admin steps use karte hain.

## Pipeline kaise trigger hoti hai

- **`main` par push** -> full pipeline: CI -> staging -> production (sab green par). Agar deploy secrets missing hon to deploy path safe-skip hota hai (warn ke saath), CI fail nahi hota.
- **Pull request** -> sirf lint/test/build (deploy jobs skip; tootne par merge mat karo).
- **Manual** (Actions -> CI/CD -> Run workflow): `staging` (CI + staging tak) ya
  `production` (CI + staging-green + production). Production manual bhi gates
  skip nahi karta.

## Staging kaise kaam karta hai

1. `DATABASE_URL=<staging> npm run db:migrate` — saari migrations additive hain
   (`IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`); **koi DROP/TRUNCATE/DELETE
   CI se kabhi nahi chalta.**
2. `railway up --service <staging-id> --environment staging`.
3. `/api/health` (200 + `ok:true`) aur `/api/ready` (200 + `db:"up"`) 5 min retry.
4. Unique phone/password wala admin banakar `scripts/smoke.js` FULL mode:
   register -> admin-verify -> booking -> accept -> GPS posts ->
   tracking `live` + latest marker + last_updated -> enterprise inquiry.
   Staging par banta test data disposable hai (staging DB kabhi prod se nahi judta).

## Production deploy kaise hota hai

Sirf jab: branch `main` **aur** staging ke saare gates green. Phir:
prod migrate -> `railway up` (production env) -> `/health` + `/ready` ->
smoke **HEALTH-ONLY** (sirf read checks — production me koi user/booking/test
data NAHI banta). Full E2E prod par automatic kabhi nahi chalta.

## Rollback kaise hota hai

Automatic DB rollback **nahi** hai (by design — migrations additive hain, purana
code naye columns ko ignore karta hai, isliye down-migration ki zaroorat nahi).

1. Railway dashboard -> service -> **Deployments** -> pichla GREEN deployment ->
   **Redeploy** (staging ya production, jo toota ho).
2. Logs me `SMOKE FAIL <gate>` / `DEPLOY RUKA` line dekho — kaaran likha hota hai.
3. Fix karke `main` par push karo — pipeline phir staging se shuru hogi.

## Local verify (CI jaisa)

```powershell
cd apnashift-backend
npm run lint
$env:TEST_DATABASE_URL='postgres://apnashift:changeme@localhost:5433/apnashift_test'
npx vitest run tests/health.test.js   # + /ready test
# Smoke health-mode (localhost server ke khilaaf, koi test data nahi):
$env:SMOKE_BASE_URL='http://localhost:3000'; $env:SMOKE_MODE='health'; node scripts/smoke.js
```

## Baaki manual steps (abhi automation ke bahar)

1. Upar wale 8 GitHub Secrets + Railway variables (staging/prod alag) set karna.
2. Railway me `staging` + `production` environments + dono services banana,
   IDs secrets me daalna. (Maujooda production service ko chheda nahi gaya.)
3. Pehli baar workflow `main` par push karke Actions tab me green dekhna —
   **real Railway deploy abhi verify nahi hua** (tokens/IDs milne ke baad hoga).
4. `docker build` local/Docker-Desktop par verify karna (is machine par Docker
   daemon available nahi tha — CI `build` job ise pakdega).
