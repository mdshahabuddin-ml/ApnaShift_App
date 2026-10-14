# Super Admin Module (Phase B)

Read-only audit (Phase A) ke baad banaya gaya naya module. **Koi existing file modify nahi hui** — neeche di gayi list ke baahar kuch nahi chhooa gaya.

## Files (sab naye)

| File | Purpose |
|---|---|
| `backend/superAdminRoutes.js` | Read-only Express router: `GET /overview`, `GET /audit-logs`, `GET /customers/:id`. SELECT-only, existing auth + tables reuse. **Mount nahi hai** (wiring pending, neeche dekho). |
| `frontend/super-admin.html` | Poora Super Admin UI (sidebar, 6 sections). Sirf EXISTING endpoints call karta hai, isliye aaj hi kaam karta hai. Copies: `apnashift-frontend/super-admin.html` + `apnashift-backend/public/super-admin.html` (CI mirror-sync rule ke liye — dono nayi files, existing pages untouched). |
| `README.md` | Ye file. |

## UI kaam kaise karta hai (bina wiring ke)

`super-admin.html` seedha in existing endpoints ko admin token (`apnashift_admin_token`, wahi jo `admin-login.html` set karta hai) ke saath call karta hai:

- Overview: `GET /api/admin/stats`, `GET /api/admin/reports/summary`, `GET /api/admin/bookings?limit=10`
- Customers: `GET /api/admin/accounts/lookup?phone=`, `PATCH /api/admin/users/:id/reset-password` (confirm ke saath)
- Drivers: `GET /api/admin/drivers?status=&page=&limit=`, verify/reject/deactivate/reactivate/reset-password, `GET /api/admin/ledger?driver_id=`, `GET /api/admin/settlements?driver_id=`
- Finance: `reports/summary`, `ledger`, `driver-balances`, `drivers/commission-summary`, `settlement-periods` (+generate/pay/dispute/resolve), `POST /settlements`, `POST /drivers/:id/settle-commission`, `POST /adjustments` (reason mandatory, confirm dialog)
- Enterprise: `GET /api/enterprise/inquiries`, `PATCH .../status` (sirf valid enum)
- Security/Audit: **gap notice** — `audit_logs` padhne ka endpoint abhi backend me nahi hai, isliye section batata hai kya log hota hai + wiring ke baad kya dikhega. Koi fake success nahi.

## Wiring status: ROUTER MOUNTED + TIER LIVE (approved Plan 2)

- `src/app.js` me mount line (`/api/superadmin`). UI ka Audit section + customer history live hain (super_admin token pe; plain admin pe 403 + sahi notice).
- `admins.role` tier live (`022_admin_roles.sql` + `schema.sql` parity). `requireRole` me super-passthrough — existing admin endpoints dono tiers ke liye khule hain.
- Pehla super_admin: `node super-admin-module/scripts/promote-super-admin.js <phone>` (manual, tumhare haath se).
2. `super_admin` tier: `admins` me role column (migration) + `requireRole` — bina iske saare admins equal hain; UI admin token maangta hai (backend-enforced).
3. Customer-suspend, complaint workflow, error-log — naye table/endpoint chahiye; document-only rakha hai.
4. Nav link existing dashboards me — nahi dala; direct URL: `/super-admin.html`.
   (Homepage pe admin-login hone par Admin/Super Admin links auto-dikhate hain —
   `index.html` me token-gated injection, public visitors ko kuch nahi dikhta.)

## Testing (Phase C ke liye tayyar)

`super-admin.html` kholo → admin token se login → har section me loading/empty/error/refresh states hain. Koi bhi action `ok:true` ke bina success nahi dikhata. Finance actions confirm-dialog + reason maangte hain.
