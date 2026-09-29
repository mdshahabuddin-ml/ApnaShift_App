// Audit log helper: kaunse admin ne kya kiya (verify/reject/assign/pricing).
// details me phone/hash kabhi mat daalo — sirf id aur badle hue fields.
import { query } from '../db.js';

const AUDIT_SQL = `INSERT INTO audit_logs (admin_id, action, entity, entity_id, details)
     VALUES ($1, $2, $3, $4, $5::jsonb)`;

function auditParams(adminId, action, entity, entityId, details = {}) {
  return [adminId, action, entity, entityId ? String(entityId) : null, JSON.stringify(details)];
}

export function logAudit(adminId, action, entity, entityId, details = {}) {
  return query(AUDIT_SQL, auditParams(adminId, action, entity, entityId, details));
}

// Pricing PUT ke liye: same transaction me audit row (COMMIT se pehle client se).
// Audit fail ho to pricing bhi rollback — rate + history + audit atomic rahe.
export function logAuditTx(client, adminId, action, entity, entityId, details = {}) {
  return client.query(AUDIT_SQL, auditParams(adminId, action, entity, entityId, details));
}

// Verify/reject/assign ke liye best-effort: audit fail ho to main action mat todo.
// Caller await kare, par 500 nahi aayega — sirf console me line jayegi.
export async function logAuditSafe(adminId, action, entity, entityId, details = {}) {
  try {
    await logAudit(adminId, action, entity, entityId, details);
  } catch (err) {
    console.error('[audit] log fail:', err.message);
  }
}
