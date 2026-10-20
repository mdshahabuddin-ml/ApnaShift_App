// 426 Upgrade Required — server-side enforcement of mandatory app updates.
// Reads X-App-Version (set by the Flutter ApiClient); absent/unparseable
// header -> allow (website, WhatsApp server flows, older binaries). Client
// dialog is UX only — protected features are gated HERE, never by client
// check alone (security requirement).
import { requiredUpdateFor } from '../services/appUpdates.js';
import { parseSemver } from '../utils/version.js';

export async function appUpdateGate(req, res, next) {
  try {
    const v = req.get('x-app-version');
    if (!v || !parseSemver(v)) return next();
    const u = await requiredUpdateFor(v.trim());
    if (!u.required) return next();
    return res.status(426).json({
      ok: false,
      error: 'update_required',
      latest_version: u.latest_version,
      min_supported_version: u.min_supported_version,
      update_url: u.update_url,
      message: u.message,
    });
  } catch (err) {
    return next(err);
  }
}
