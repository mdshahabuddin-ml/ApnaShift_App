// Item 5 (unit, DB nahi chahiye): logAuditSafe best-effort hai.
// DB down ho (DATABASE_URL missing) to bhi reject nahi hona chahiye.
import { describe, it, expect } from 'vitest';
import { logAuditSafe } from '../src/services/audit.js';

describe('logAuditSafe — best-effort', () => {
  it('DB fail ho to bhi resolve (throw nahi)', async () => {
    await expect(
      logAuditSafe('00000000-0000-0000-0000-000000000000', 'test.action', 'test', 'x', {}),
    ).resolves.toBeUndefined();
  });
});
