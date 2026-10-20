// App releases: version config, update-action decision, scheduled FCM push.
// "Latest published release" is DERIVED per query (status='published', newest
// published_at first) — archive a row to retire it; no activation job.
// Push dispatch is crash-safe exactly like announcements: DB-level dedupe
// (app_release_push_log UNIQUE) + status-CAS claim; a re-run skips
// already-sent rows and NEVER double-sends a release notice.
import { query } from '../db.js';
import { config } from '../config.js';
import { fcmConfigured, sendToDeviceToken } from './fcm.js';
import { cmpSemver, isOlderThan, parseSemver } from '../utils/version.js';

export const RELEASE_COLS = `id, version, build, min_supported_version, mandatory,
  audience, priority, release_notes, update_url, status, push_enabled, push_title,
  push_body, push_scheduled_at, push_status, push_sent_at, push_total,
  push_delivered, push_failed, created_by, created_at, updated_at, published_at`;

const truthy = (v) => v === true || v === 1;

const iso = (v) => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export function toPublicRelease(row) {
  return {
    id: row.id,
    version: row.version,
    build: row.build === null || row.build === undefined ? null : Number(row.build),
    min_supported_version: row.min_supported_version ?? null,
    mandatory: truthy(row.mandatory),
    audience: row.audience,
    priority: row.priority,
    release_notes: row.release_notes ?? '',
    update_url: row.update_url ?? null,
    status: row.status,
    push: {
      enabled: truthy(row.push_enabled),
      scheduled_at: iso(row.push_scheduled_at),
      status: row.push_status,
      sent_at: iso(row.push_sent_at),
      total: Number(row.push_total ?? 0),
      delivered: Number(row.push_delivered ?? 0),
      failed: Number(row.push_failed ?? 0),
    },
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    published_at: iso(row.published_at),
  };
}

// ---------------------------------------------------- published releases
// Published rows are stable between writes — 60s read cache (disabled in
// tests so truncateAll is always visible immediately). Any write calls
// invalidateReleaseCache() so admin actions take effect at once.
let pubCache = { at: 0, rows: null };
const CACHE_MS = config.env === 'test' ? 0 : 60_000;

export function invalidateReleaseCache() {
  pubCache = { at: 0, rows: null };
}

async function publishedReleases() {
  const now = Date.now();
  if (pubCache.rows && now - pubCache.at < CACHE_MS) return pubCache.rows;
  const r = await query(
    `SELECT ${RELEASE_COLS} FROM app_releases
      WHERE status = 'published'
      ORDER BY published_at DESC, created_at DESC`,
    [],
  );
  pubCache = { at: now, rows: r.rows };
  return r.rows;
}

// ------------------------------------------------------------- decisions
// PURE decision fn (unit-testable): installed version + published rows
// (newest first) -> action. Rules:
//   no published row / unknown installed version -> none (never punish)
//   installed >= latest                            -> none
//   installed < ANY mandatory published release    -> required
//   installed < latest.min_supported_version       -> required
//   installed < latest (rest)                      -> optional
// Payload metadata (notes/url/priority) always comes from the LATEST row —
// that's the version the client is sent to.
export function decideAction(installedVersion, rows) {
  const base = {
    action: 'none',
    latest_version: null,
    build: null,
    min_supported_version: null,
    mandatory: false,
    update_url: null,
    priority: 'normal',
    release_notes: '',
  };
  if (!rows || rows.length === 0) return base;
  const latest = rows[0];
  const payload = {
    ...base,
    latest_version: latest.version,
    build: latest.build === null || latest.build === undefined ? null : Number(latest.build),
    min_supported_version: latest.min_supported_version ?? null,
    mandatory: truthy(latest.mandatory),
    update_url: latest.update_url ?? null,
    priority: latest.priority ?? 'normal',
    release_notes: latest.release_notes ?? '',
  };
  if (!parseSemver(installedVersion)) return payload;
  if (cmpSemver(installedVersion, latest.version) >= 0) return payload;
  const forced = rows.find(
    (r) => truthy(r.mandatory) && isOlderThan(installedVersion, r.version),
  );
  if (forced) return { ...payload, action: 'required', mandatory: true };
  if (
    latest.min_supported_version &&
    isOlderThan(installedVersion, latest.min_supported_version)
  ) {
    return { ...payload, action: 'required' };
  }
  return { ...payload, action: 'optional' };
}

// Public payload for GET /api/app-updates/latest?version=...
export async function updateStateFor(installedVersion) {
  const rows = await publishedReleases();
  return {
    served_at: new Date().toISOString(),
    installed_version: installedVersion ?? null,
    ...decideAction(installedVersion, rows),
  };
}

// Gate payload for appUpdateGate (426 when required).
export async function requiredUpdateFor(installedVersion) {
  const rows = await publishedReleases();
  const d = decideAction(installedVersion, rows);
  const required = d.action === 'required';
  return {
    required,
    latest_version: d.latest_version,
    min_supported_version: d.min_supported_version,
    update_url: d.update_url,
    message: required
      ? `App update required — please install version ${d.latest_version} to continue.`
      : null,
  };
}

// ---------------------------------------------------------------- dispatch
function audienceRoles(audience) {
  if (audience === 'users') return ['user'];
  if (audience === 'drivers') return ['driver'];
  return ['user', 'driver'];
}

async function dispatchRelease(a) {
  const roles = audienceRoles(a.audience);
  const ph = roles.map((_, i) => `$${i + 1}`).join(', ');
  const tokens = await query(
    `SELECT DISTINCT owner_role, owner_id, token FROM device_tokens WHERE owner_role IN (${ph})`,
    roles,
  );
  const title = a.push_title || `ApnaShift v${a.version} available`;
  const body = a.push_body || String(a.release_notes ?? '').slice(0, 500) || 'Naya app version available hai — update karo.';
  let sent = 0;
  let failed = 0;
  let oauthDead = false;
  for (const t of tokens.rows) {
    if (!t.token) continue;
    // Dedupe: UNIQUE (release, role, owner, token) — duplicate key on a
    // crash-restart means this row was already handled, skip without sending.
    try {
      await query(
        `INSERT INTO app_release_push_log (release_id, owner_role, owner_id, token)
         VALUES ($1, $2, $3, $4)`,
        [a.id, t.owner_role, t.owner_id, t.token],
      );
    } catch (err) {
      if (err.code === '23505' || err.code === '2627' || err.number === 2627) continue;
      throw err;
    }
    const r = await sendToDeviceToken(t.token, {
      title,
      body,
      data: { release_id: String(a.id), version: String(a.version) },
    });
    if (r.ok) {
      sent += 1;
      await query(
        `UPDATE app_release_push_log SET status = 'sent'
          WHERE release_id = $1 AND owner_role = $2 AND owner_id = $3 AND token = $4`,
        [a.id, t.owner_role, t.owner_id, t.token],
      ).catch(() => {});
    } else {
      failed += 1;
      const shortErr = String(r.error ?? 'send_failed').slice(0, 190);
      await query(
        `UPDATE app_release_push_log SET status = 'failed', error = $5
          WHERE release_id = $1 AND owner_role = $2 AND owner_id = $3 AND token = $4`,
        [a.id, t.owner_role, t.owner_id, t.token, shortErr],
      ).catch(() => {});
      if (r.dead) {
        await query(
          'DELETE FROM device_tokens WHERE owner_role = $1 AND owner_id = $2 AND token = $3',
          [t.owner_role, t.owner_id, t.token],
        ).catch(() => {});
      }
      if (r.oauth) oauthDead = true;
    }
    if (oauthDead) break;
  }
  const status = failed === 0 ? 'sent' : sent === 0 ? 'failed' : 'partial';
  await query(
    `UPDATE app_releases
        SET push_status = $2, push_sent_at = now(), push_total = $3,
            push_delivered = $4, push_failed = $5, updated_at = now()
      WHERE id = $1`,
    [a.id, status, sent + failed, sent, failed],
  );
  return { id: a.id, status, sent, failed };
}

// Fire all due, published, scheduled release pushes. Never throws (ticker
// wraps anyway). Without FCM_* creds: {skipped:'awaiting_credentials'}.
export async function dispatchDueReleasePushes() {
  if (!fcmConfigured()) return { skipped: 'awaiting_credentials', due: 0, results: [] };
  const due = await query(
    `SELECT id, version, release_notes, push_title, push_body, audience
       FROM app_releases
      WHERE push_enabled = 1 AND push_status = 'scheduled' AND status = 'published'
        AND push_scheduled_at IS NOT NULL AND push_scheduled_at <= now()
      ORDER BY push_scheduled_at ASC`,
    [],
  );
  const results = [];
  for (const a of due.rows) {
    // CAS claim — only one dispatcher process wins this row.
    const claimed = await query(
      `UPDATE app_releases SET push_status = 'sending', updated_at = now()
        WHERE id = $1 AND push_status = 'scheduled'`,
      [a.id],
    );
    if (claimed.rowCount !== 1) continue;
    try {
      results.push(await dispatchRelease(a));
    } catch (err) {
      console.error('[app-release] dispatch fail:', err.message);
      await query(
        `UPDATE app_releases SET push_status = 'failed', updated_at = now()
          WHERE id = $1 AND push_status = 'sending'`,
        [a.id],
      ).catch(() => {});
    }
  }
  return { skipped: null, due: due.rowCount, results };
}

// ------------------------------------------------------------------ ticker
// In-process scheduler (same pattern as startAnnouncementTicker). Started
// ONLY from server.js so supertest never spawns it.
let tickerTimer = null;

export function startReleaseTicker(intervalMs = 30000) {
  if (tickerTimer) return tickerTimer;
  const tick = () => {
    dispatchDueReleasePushes().catch((err) =>
      console.error('[app-release] tick fail:', err.message),
    );
  };
  const boot = setTimeout(tick, 5000);
  if (typeof boot.unref === 'function') boot.unref();
  tickerTimer = setInterval(tick, intervalMs);
  if (typeof tickerTimer.unref === 'function') tickerTimer.unref();
  return tickerTimer;
}

export function stopReleaseTicker() {
  if (tickerTimer) {
    clearInterval(tickerTimer);
    tickerTimer = null;
  }
}
