// Audit log helper: records which admin did what (verify/reject/assign/pricing).
// Never put phone/hash in details — only ids and changed fields.
import { query } from '../db.js';

const AUDIT_SQL = `INSERT INTO audit_logs (admin_id, action, entity, entity_id, details)
     VALUES ($1, $2, $3, $4, $5::jsonb)`;

function auditParams(adminId, action, entity, entityId, details = {}) {
  return [adminId, action, entity, entityId ? String(entityId) : null, JSON.stringify(details)];
}

export function logAudit(adminId, action, entity, entityId, details = {}) {
  return query(AUDIT_SQL, auditParams(adminId, action, entity, entityId, details));
}

// For pricing PUT: audit row in the same transaction (via client before COMMIT).
// If audit fails, pricing rolls back too — rate + history + audit stay atomic.
export function logAuditTx(client, adminId, action, entity, entityId, details = {}) {
  return client.query(AUDIT_SQL, auditParams(adminId, action, entity, entityId, details));
}

// Best-effort for verify/reject/assign: never block the main action on audit failure.
// Caller awaits it, but no 500 is thrown — only a console line is logged.
export async function logAuditSafe(adminId, action, entity, entityId, details = {}) {
  try {
    await logAudit(adminId, action, entity, entityId, details);
  } catch (err) {
    console.error('[audit] log fail:', err.message);
  }
}
