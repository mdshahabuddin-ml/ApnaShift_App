# D1 — Host options for launch (decision doc, compiled 2026-10-18)

Railway winds down ≈Oct 31 (D5). At launch we need two things: **(a) where the
app runs**, **(b) where the data runs — and on which engine**. The app is
dual-engine by design (`DB_DRIVER=mssql|pg`); this repo's MSSQL work is
production-ready either way (rehearsal + CI green), so the engine is a choice,
not a constraint.

## Facts verified 2026-10-18 (sources: Microsoft/Railway/Oracle docs + pricing pages)

- **SQL Server Express = FREE for production** — 10 GB/database cap (2025
  edition: 50 GB), ≤4 cores, ~1.4 GB buffer pool. 42-row app = years of headroom.
- **SQL Server (all editions, incl. Docker images) = x64 only** — MS docs:
  "supported only on Linux hosts running on Intel and AMD x86-64 CPUs."
  Oracle's free ARM VM **cannot** run it. Emulation unsupported.
- **Railway (current pricing):** Free $0 = $1 usage credit/mo + **no custom
  domain after trial → not production-viable**. **Hobby = $5/mo** (includes $5
  usage credit; our measured usage $1.43 → total $5/mo). Pro $20. Usage rates:
  RAM $10/GB/mo, CPU $20/vCore/mo, egress $0.05/GB, volume $0.15/GB/mo.
- **Azure SQL (cheapest managed MSSQL):** Basic DTU ≈ **$5/mo** (B1s ≈
  $6.20/mo in India region); serverless GP bills per-second with auto-pause →
  possibly ≈$1–3/mo for tiny intermittent load (cold-start ~1 s). Azure free
  account has 12-month offers — verify exact SQL offer at signup (card needed).
- **Oracle Always Free:** 2 OCPU / 12 GB ARM VM + 2 AMD micro VMs (1 GB) free
  forever — runs the Node app or Postgres, **not** SQL Server (x64-only).
  DIY ops; free-account signup sometimes rejected/suspended.

## Options (steady-state monthly cost for app + DB)

| # | Combo | Engine | $/mo | Effort | Tradeoffs |
|---|---|---|---|---|---|
| A | Railway Hobby (app + Postgres) | PG | **~$5** | Trivial — existing CI/config unchanged | MSSQL stays dev/backup engine; zero migration risk; custom domain ✓ |
| B | Azure (app host + Azure SQL Basic) | MSSQL | **~$10–20** | Medium — new host + Phase 3/4 run for real | One provider; managed backups/HA/patching; uses this project's MSSQL work fully; needs Azure account + card (your earlier "abhi ruko") |
| C | Railway app + Azure SQL Basic DB | MSSQL | **~$10** | Medium — two providers | Cheapest real managed MSSQL; app stays where CI already works; cross-cloud latency (irrelevant at this size) |
| D | Oracle ARM free VM (app + Postgres) | PG | **$0** | High — DIY server, firewall, TLS, backups | $0 forever; **no MSSQL**; signup/suspension risk; ops burden |
| E | x64 VPS (≈$4–5) + SQL Server Express | MSSQL | **~$5** | High — DIY everything; Express 10 GB cap | Real MSSQL at $0 license; you own backups (our `copy-backups.ps1` pattern) |

## Recommendation

- **Goal = production on MSSQL** (the point of this project) → **C**
  (lowest risk, ~$10/mo) or **B** if you prefer a single provider (~$10–20/mo).
  Phase 3/4 playbook + verifiers are proven; only host-specific env vars change.
- **Goal = cheapest stable launch** → **A** (~$5/mo). All MSSQL assets stay
  green (CI, rehearsal, backup tooling) and the cutover can happen later —
  `DB_DRIVER` flip + Phase 3/4 remains a one-window operation.
- **D/E** only if $0 or full control matters more than your time.

**Decision needed at launch (this is the D1 gate for Phase 3).** Costs are
list prices as of 2026-10-18; re-check at signup.
