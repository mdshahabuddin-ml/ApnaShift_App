// FCM push sender — Phase-2 plumbing with zero new dependencies.
// OAuth2 assertion is signed with the already-installed `jsonwebtoken`,
// delivery uses global fetch against FCM HTTP v1.
// Contract: without FCM_PROJECT_ID + FCM_CLIENT_EMAIL + FCM_PRIVATE_KEY in
// env, every call resolves { skipped: true } — push stays OFF and the
// in-app notification row remains the source of truth. Nothing here ever
// logs keys or tokens (counts only). Push failures never throw into
// booking flows (notifyCenter also wraps best-effort).
import jwt from 'jsonwebtoken';
import { query } from '../db.js';

const OAUTH_URL = 'https://oauth2.googleapis.com/token';
const OAUTH_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

let cached = null; // { access, expMs }

export function fcmConfig() {
  const projectId = process.env.FCM_PROJECT_ID ?? '';
  const clientEmail = process.env.FCM_CLIENT_EMAIL ?? '';
  // Railway single-line keys arrive with literal \n — restore real newlines.
  const privateKey = (process.env.FCM_PRIVATE_KEY ?? '').replace(/\\n/g, '\n');
  if (!projectId || !clientEmail || !privateKey) return null;
  return { projectId, clientEmail, privateKey };
}

export function fcmConfigured() {
  return fcmConfig() !== null;
}

async function accessToken() {
  const now = Date.now();
  if (cached && cached.expMs - now > 5 * 60 * 1000) return cached.access;
  const cfg = fcmConfig();
  const iat = Math.floor(now / 1000);
  const assertion = jwt.sign(
    {
      iss: cfg.clientEmail,
      scope: OAUTH_SCOPE,
      aud: OAUTH_URL,
      iat,
      exp: iat + 3600,
    },
    cfg.privateKey,
    { algorithm: 'RS256' },
  );
  const res = await fetch(OAUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) throw new Error(`oauth ${res.status}`);
  const data = await res.json();
  cached = { access: data.access_token, expMs: now + (data.expires_in ?? 3600) * 1000 };
  return cached.access;
}

function fcmUrl(projectId) {
  return `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
}

// Single-token send for the announcement dispatcher (dispatch tracks every
// attempt in announcement_push_log). Never throws.
//   ok       -> accepted by FCM
//   dead     -> FCM says token is gone (404/410/UNREGISTERED) -> caller prunes
//   oauth    -> credential problem (caller should abort the batch)
export async function sendToDeviceToken(token, { title, body, data = {} }) {
  try {
    const cfg = fcmConfig();
    if (!cfg) return { ok: false, error: 'not_configured' };
    const access = await accessToken();
    const strData = {};
    for (const [k, v] of Object.entries(data)) strData[String(k)] = String(v);
    const res = await fetch(fcmUrl(cfg.projectId), {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: { token, notification: { title, body }, data: strData },
      }),
    });
    if (res.ok) return { ok: true };
    const txt = await res.text().catch(() => '');
    let fcmCode = '';
    try {
      fcmCode = JSON.parse(txt)?.error?.code ?? '';
    } catch {
      // Non-JSON error body — HTTP status is all we know.
    }
    const dead =
      res.status === 404 || res.status === 410 || fcmCode === 'UNREGISTERED' || fcmCode === 'NOT_FOUND';
    return {
      ok: false,
      error: fcmCode || `http_${res.status}`,
      dead,
    };
  } catch (err) {
    const oauth = /oauth/i.test(String(err?.message ?? ''));
    return { ok: false, error: oauth ? 'oauth_fail' : 'send_fail', oauth };
  }
}

// Best-effort fan-out to one owner's registered tokens. Always resolves.
export async function pushToOwner(ownerRole, ownerId, { title, body, data = {} }) {
  try {
    const cfg = fcmConfig();
    if (!cfg) return { skipped: true, sent: 0, failed: 0 };
    const rows = await query('SELECT token FROM device_tokens WHERE owner_role = $1 AND owner_id = $2', [
      ownerRole,
      ownerId,
    ]);
    const tokens = rows.rows.map((r) => r.token).filter(Boolean).slice(0, 100);
    if (tokens.length === 0) return { skipped: true, sent: 0, failed: 0 };
    const access = await accessToken();
    let sent = 0;
    let failed = 0;
    const strData = {};
    for (const [k, v] of Object.entries(data)) strData[String(k)] = String(v);
    for (const token of tokens) {
      try {
        const res = await fetch(fcmUrl(cfg.projectId), {
          method: 'POST',
          headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: { token, notification: { title, body }, data: strData },
          }),
        });
        if (res.ok) sent += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }
    return { skipped: false, sent, failed };
  } catch (err) {
    console.error('[fcm] send fail:', err.message);
    return { skipped: false, sent: 0, failed: 0 };
  }
}
