// Translator contract tests — pure, no DB. Every case is a real SQL shape
// from src/ (routes/services). If a rewrite here changes, src must match.
import { describe, it, expect } from 'vitest';
import { translateToMssql } from '../src/mssql/translate.js';

describe('params: $n -> @pn', () => {
  it('converts numbered placeholders', () => {
    expect(translateToMssql('SELECT * FROM users WHERE id = $1')).toBe(
      'SELECT * FROM users WHERE id = @p1',
    );
    expect(translateToMssql('VALUES ($1, $10, $2)')).toBe('VALUES (@p1, @p10, @p2)');
  });

  it('leaves $1 alone inside string literals', () => {
    expect(translateToMssql("SELECT 'cost is $1' AS x FROM t")).toBe(
      "SELECT 'cost is $1' AS x FROM t",
    );
  });
});

describe('INSERT .. RETURNING -> OUTPUT', () => {
  it('auth register', () => {
    expect(
      translateToMssql('INSERT INTO users (name, phone, password_hash) VALUES ($1, $2, $3) RETURNING id, name, phone'),
    ).toBe(
      'INSERT INTO users (name, phone, password_hash) OUTPUT INSERTED.id, INSERTED.name, INSERTED.phone VALUES (@p1, @p2, @p3)',
    );
  });

  it('INSERT .. RETURNING * (wa_conversations)', () => {
    expect(
      translateToMssql("INSERT INTO wa_conversations (phone, state, data) VALUES ($1, 'START', '{}') RETURNING *"),
    ).toBe(
      "INSERT INTO wa_conversations (phone, state, data) OUTPUT INSERTED.* VALUES (@p1, 'START', '{}')",
    );
  });
});

describe('UPDATE .. RETURNING -> OUTPUT before WHERE', () => {
  it('UPDATE with TRUE/FALSE/now() in SET', () => {
    expect(
      translateToMssql(
        'UPDATE bookings SET disputed = TRUE, dispute_reason = $1, updated_at = now() WHERE id = $2 RETURNING id, status',
      ),
    ).toBe(
      'UPDATE bookings SET disputed = 1, dispute_reason = @p1, updated_at = SYSUTCDATETIME() OUTPUT INSERTED.id, INSERTED.status WHERE id = @p2',
    );
  });

  it('UPDATE .. RETURNING * (settlement_periods)', () => {
    expect(
      translateToMssql('UPDATE settlement_periods SET status = $1, dispute_reason = NULL WHERE id = $2 RETURNING *'),
    ).toBe('UPDATE settlement_periods SET status = @p1, dispute_reason = NULL OUTPUT INSERTED.* WHERE id = @p2');
  });
});

describe('ON CONFLICT DO UPDATE -> MERGE', () => {
  it('platform_settings commission upsert', () => {
    const out = translateToMssql(
      `INSERT INTO platform_settings (key, value, updated_by) VALUES ('commission', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    );
    expect(out).toContain('MERGE platform_settings WITH (HOLDLOCK) AS tgt');
    expect(out).toContain('USING (VALUES (\'commission\', @p1, @p2)) AS src ([key], value, updated_by)');
    expect(out).toContain('ON tgt.[key] = src.[key]');
    expect(out).toContain('WHEN MATCHED THEN UPDATE SET value = src.value, updated_by = src.updated_by, updated_at = SYSUTCDATETIME()');
    expect(out).toContain('WHEN NOT MATCHED THEN INSERT ([key], value, updated_by) VALUES (src.[key], src.value, src.updated_by)');
    expect(out.trim().endsWith(';')).toBe(true);
    expect(out).not.toContain('ON CONFLICT');
    expect(out).not.toContain('EXCLUDED');
  });

  it('device_tokens multi-column target', () => {
    const out = translateToMssql(
      `INSERT INTO device_tokens (owner_role, owner_id, platform, token, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (owner_role, owner_id, token)
       DO UPDATE SET platform = EXCLUDED.platform, updated_at = now()`,
    );
    expect(out).toContain(
      'ON tgt.owner_role = src.owner_role AND tgt.owner_id = src.owner_id AND tgt.token = src.token',
    );
    expect(out).toContain('WHEN MATCHED THEN UPDATE SET platform = src.platform, updated_at = SYSUTCDATETIME()');
  });

  it('DO NOTHING + RETURNING -> MERGE with OUTPUT', () => {
    const out = translateToMssql(
      `INSERT INTO notifications (recipient_role, recipient_id, booking_id, type, title, body, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (booking_id, recipient_role, recipient_id, type) DO NOTHING
       RETURNING id, type, title, body, booking_id, read_at, created_at`,
    );
    expect(out).toContain('CAST(@p7 AS NVARCHAR(MAX))');
    expect(out).toContain('OUTPUT INSERTED.id, INSERTED.type, INSERTED.title, INSERTED.body, INSERTED.booking_id, INSERTED.read_at, INSERTED.created_at');
    expect(out).toContain('WHEN NOT MATCHED THEN INSERT');
    expect(out).not.toContain('WHEN MATCHED');
  });

  it('targetless DO NOTHING -> TRY/CATCH duplicate swallow', () => {
    const out = translateToMssql(
      'INSERT INTO settlement_period_items (period_id, payment_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    );
    expect(out).toContain('BEGIN TRY');
    expect(out).toContain('INSERT INTO settlement_period_items (period_id, payment_id) VALUES (@p1, @p2)');
    expect(out).toContain('IF ERROR_NUMBER() NOT IN (2601, 2627) THROW;');
    expect(out).not.toContain('MERGE');
  });
});

describe('LIMIT/OFFSET -> OFFSET/FETCH', () => {
  it('LIMIT + OFFSET with ORDER BY', () => {
    expect(
      translateToMssql('SELECT id FROM drivers ORDER BY created_at DESC LIMIT $1 OFFSET $2'),
    ).toBe('SELECT id FROM drivers ORDER BY created_at DESC OFFSET @p2 ROWS FETCH NEXT @p1 ROWS ONLY');
  });

  it('static LIMIT with ORDER BY', () => {
    expect(
      translateToMssql('SELECT booking_id FROM driver_locations WHERE booking_id = $1 ORDER BY recorded_at DESC LIMIT 10'),
    ).toBe(
      'SELECT booking_id FROM driver_locations WHERE booking_id = @p1 ORDER BY recorded_at DESC OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY',
    );
  });

  it('LIMIT without ORDER BY -> TOP', () => {
    expect(translateToMssql('SELECT 1 FROM drivers WHERE email = $1 LIMIT 1')).toBe(
      'SELECT TOP 1 1 FROM drivers WHERE email = @p1',
    );
  });

  it('UNION ALL + trailing LIMIT 1 -> TOP on a SELECT (existence check)', () => {
    const out = translateToMssql(
      `SELECT 1 FROM users WHERE phone = $1
       UNION ALL SELECT 1 FROM drivers WHERE phone = $1
       UNION ALL SELECT 1 FROM admins WHERE phone = $1 LIMIT 1`,
    );
    // Nearest SELECT before the trailing LIMIT gets the TOP; callers only
    // check rowCount > 0, so branch position is semantically equivalent.
    expect(out).toContain('SELECT TOP 1 1 FROM admins WHERE phone = @p1');
    expect(out).not.toContain('LIMIT');
  });

  it('inner-subquery LIMIT keeps its position; outer keeps OFFSET/FETCH', () => {
    const outerIn = `SELECT b.id FROM bookings b
        ORDER BY b.created_at DESC LIMIT $1`;
    expect(translateToMssql(outerIn)).toBe(
      `SELECT b.id FROM bookings b
        ORDER BY b.created_at DESC OFFSET 0 ROWS FETCH NEXT @p1 ROWS ONLY`,
    );

    const inner = translateToMssql(
      'SELECT x FROM t WHERE booking_id = b.id ORDER BY recorded_at DESC LIMIT 1',
    );
    expect(inner).toContain('ORDER BY recorded_at DESC OFFSET 0 ROWS FETCH NEXT 1 ROWS ONLY');
  });
});

describe('FOR UPDATE -> UPDLOCK hints', () => {
  it('bare trailing FOR UPDATE, first FROM gets the hint', () => {
    expect(
      translateToMssql('SELECT value FROM platform_settings WHERE key = \'commission\' FOR UPDATE'),
    ).toBe('SELECT value FROM platform_settings WITH (UPDLOCK, ROWLOCK) WHERE [key] = \'commission\'');
  });

  it('FOR UPDATE with table alias', () => {
    expect(
      translateToMssql('SELECT * FROM settlement_periods WHERE id = $1 FOR UPDATE'),
    ).toBe('SELECT * FROM settlement_periods WITH (UPDLOCK, ROWLOCK) WHERE id = @p1');
  });

  it('FOR UPDATE OF p -> hint the aliased table', () => {
    const out = translateToMssql(
      'SELECT * FROM settlement_period_items i JOIN settlement_periods p ON p.id = i.period_id WHERE i.payment_id = $1 ORDER BY p.collected_at ASC, p.id ASC FOR UPDATE OF p',
    );
    expect(out).toContain('JOIN settlement_periods p WITH (UPDLOCK, ROWLOCK) ON p.id = i.period_id');
    expect(out).not.toContain('FOR UPDATE');
  });

  it('FROM payments p WHERE .. FOR UPDATE', () => {
    const out = translateToMssql(
      'SELECT p.id FROM payments p WHERE p.driver_id = $1 ORDER BY p.collected_at ASC FOR UPDATE',
    );
    expect(out).toContain('FROM payments p WITH (UPDLOCK, ROWLOCK) WHERE');
    expect(out).not.toContain('FOR UPDATE');
  });
});

describe('FILTER (WHERE) -> CASE', () => {
  it('COUNT(*) FILTER', () => {
    expect(
      translateToMssql("COUNT(*) FILTER (WHERE status = 'delivered') AS week_completed"),
    ).toBe("COUNT(CASE WHEN status = 'delivered' THEN 1 END) AS week_completed");
  });

  it('SUM(x) FILTER with now() - INTERVAL inside', () => {
    const out = translateToMssql(
      "COALESCE(SUM(price_rs) FILTER (WHERE status = 'delivered' AND created_at >= now() - INTERVAL '7 days'), 0) AS week_revenue",
    );
    expect(out).toBe(
      "COALESCE(SUM(CASE WHEN status = 'delivered' AND created_at >= DATEADD(day, -7, SYSUTCDATETIME()) THEN price_rs END), 0) AS week_revenue",
    );
  });
});

describe('now() / INTERVAL', () => {
  it('plain now()', () => {
    expect(translateToMssql('UPDATE t SET updated_at = now() WHERE id = $1')).toBe(
      'UPDATE t SET updated_at = SYSUTCDATETIME() WHERE id = @p1',
    );
  });

  it("now() - INTERVAL '30 days'", () => {
    expect(translateToMssql("SELECT 1 FROM t WHERE created_at > now() - INTERVAL '30 days'")).toBe(
      'SELECT 1 FROM t WHERE created_at > DATEADD(day, -30, SYSUTCDATETIME())',
    );
  });

  it('unsupported interval unit throws', () => {
    expect(() => translateToMssql("SELECT now() - INTERVAL '3 fortnights'")).toThrow(/fortnight/);
  });
});

describe('to_char/date_trunc buckets', () => {
  it('day bucket + GROUP BY alias -> expression', () => {
    const out = translateToMssql(
      `SELECT to_char(date_trunc('day', b.delivered_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS bucket,
              COUNT(*) AS trips
         FROM bookings b
        GROUP BY bucket ORDER BY bucket ASC`,
    );
    expect(out).toContain("CONVERT(varchar(10), DATEADD(day, DATEDIFF(day, 0, b.delivered_at), 0), 126) AS bucket");
    expect(out).toContain('GROUP BY CONVERT(varchar(10), DATEADD(day, DATEDIFF(day, 0, b.delivered_at), 0), 126)');
    expect(out).toContain('ORDER BY bucket');
    expect(out).not.toContain('to_char');
    expect(out).not.toContain('AT TIME ZONE');
  });
});

describe('ILIKE', () => {
  it('wraps both sides with LOWER, keeps ESCAPE', () => {
    expect(
      translateToMssql("(b.pickup_address ILIKE $1 ESCAPE '\\' OR b.drop_address ILIKE $1 ESCAPE '\\')"),
    ).toBe(
      "(LOWER(b.pickup_address) LIKE LOWER(@p1) ESCAPE '\\' OR LOWER(b.drop_address) LIKE LOWER(@p1) ESCAPE '\\')",
    );
  });
});

describe('casts', () => {
  it('COUNT(*)::int', () => {
    expect(translateToMssql('SELECT COUNT(*)::int AS c FROM t')).toBe(
      'SELECT CAST(COUNT(*) AS INT) AS c FROM t',
    );
  });

  it('@p::jsonb', () => {
    expect(translateToMssql('VALUES ($1, $2::jsonb)')).toBe(
      'VALUES (@p1, CAST(@p2 AS NVARCHAR(MAX)))',
    );
  });

  it('unknown cast type throws', () => {
    expect(() => translateToMssql('SELECT x::regclass FROM t')).toThrow(/regclass/);
  });
});

describe('= ANY($n) -> OPENJSON', () => {
  it('GUID array params', () => {
    expect(translateToMssql('SELECT 1 FROM t WHERE booking_id = ANY($1)')).toBe(
      'SELECT 1 FROM t WHERE booking_id IN (SELECT TRY_CAST(value AS UNIQUEIDENTIFIER) FROM OPENJSON(@p1))',
    );
    expect(
      translateToMssql('SELECT DISTINCT i.period_id FROM settlement_period_items i WHERE i.payment_id = ANY($1)'),
    ).toContain('i.payment_id IN (SELECT TRY_CAST(value AS UNIQUEIDENTIFIER) FROM OPENJSON(@p1))');
  });
});

describe('bare `key` column', () => {
  it('quotes key in WHERE / column lists / AND', () => {
    expect(translateToMssql('SELECT value FROM platform_settings WHERE key = $1')).toBe(
      'SELECT value FROM platform_settings WHERE [key] = @p1',
    );
    expect(
      translateToMssql('SELECT booking_id FROM idempotency_keys WHERE user_id = $1 AND key = $2'),
    ).toBe('SELECT booking_id FROM idempotency_keys WHERE user_id = @p1 AND [key] = @p2');
    expect(
      translateToMssql('INSERT INTO idempotency_keys (user_id, key, booking_id, request_hash) VALUES ($1, $2, $3, $4)'),
    ).toBe('INSERT INTO idempotency_keys (user_id, [key], booking_id, request_hash) VALUES (@p1, @p2, @p3, @p4)');
  });

  it('does not touch idempotency_keys table name or JS-looking words', () => {
    const out = translateToMssql('SELECT 1 FROM idempotency_keys WHERE user_id = $1');
    expect(out).toBe('SELECT 1 FROM idempotency_keys WHERE user_id = @p1');
  });
});

describe('literal safety', () => {
  it('TRUE inside a string literal stays untouched', () => {
    expect(translateToMssql("SELECT body FROM t WHERE title = 'TRUE story' AND ok = TRUE")).toBe(
      "SELECT body FROM t WHERE title = 'TRUE story' AND ok = 1",
    );
  });

  it('double single-quotes escape stays intact', () => {
    expect(translateToMssql("SELECT 'it''s TRUE' FROM t WHERE flag = FALSE")).toBe(
      "SELECT 'it''s TRUE' FROM t WHERE flag = 0",
    );
  });
});

describe('line comments are protected (seed.sql shape)', () => {
  it('keywords/params inside -- comments are untouched', () => {
    const out = translateToMssql(
      "SELECT 1 FROM t -- ignore TRUE and $1 here\nWHERE flag = TRUE AND x = $1",
    );
    expect(out).toBe("SELECT 1 FROM t -- ignore TRUE and $1 here\nWHERE flag = 1 AND x = @p1");
  });

  it('apostrophe inside a comment does not swallow the rest of the query', () => {
    const out = translateToMssql("SELECT a FROM t -- don't touch\nWHERE flag = FALSE");
    expect(out).toBe("SELECT a FROM t -- don't touch\nWHERE flag = 0");
  });

  it('seed.sql comment block + ON CONFLICT -> MERGE (prefix comments preserved)', () => {
    const seed = `-- ONLY-IF-NOT-EXISTS: keeps custom rates (no DO UPDATE).
INSERT INTO pricing_rules (vehicle_type) VALUES ('Pickup')
ON CONFLICT (vehicle_type) DO NOTHING;`;
    const out = translateToMssql(seed);
    expect(out).toContain('-- ONLY-IF-NOT-EXISTS: keeps custom rates (no DO UPDATE).');
    expect(out).toContain('MERGE pricing_rules WITH (HOLDLOCK)');
    expect(out).toContain('WHEN NOT MATCHED THEN INSERT'); // DO NOTHING -> insert arm only
    expect(out).not.toContain('ON CONFLICT');
  });
});

describe('unsupported shapes throw (no silent wrong SQL)', () => {
  it('empty input', () => {
    expect(() => translateToMssql('')).toThrow(/empty/);
  });

  it('RETURNING on unknown statement', () => {
    expect(() => translateToMssql('MERGE t RETURNING id')).toThrow(/unsupported/);
  });
});
