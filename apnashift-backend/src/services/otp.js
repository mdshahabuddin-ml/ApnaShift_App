// Zero-cost OTP service for self-service password reset.
//
// Cost sach:
//   - OTP GENERATE karna FREE hai (crypto.randomInt — koi provider nahi).
//   - OTP BHEJNA (SMS ~Rs 0.13-0.25/msg, WhatsApp ~Rs 0.11-0.30/msg,
//     Firebase Phone per-SMS billed) PAID hai.
//   - Isliye default sender ZERO-COST hai: dev/test me OTP server console
//     me log hota hai, production me SMS provider lagne tak WhatsApp
//     fallback chalta rahega. Plain OTP kabhi DB me store nahi hota —
//     sirf HMAC-SHA256 hash (pepper = OTP_PEPPER ya JWT_SECRET).
import crypto from 'node:crypto';
import { config } from '../config.js';

export const OTP_LENGTH = 6;
export const OTP_TTL_MS = 10 * 60 * 1000; // 10 min
export const OTP_MAX_ATTEMPTS = 5; // galat OTP 5 baar -> code dead
export const OTP_MAX_PER_WINDOW = 3; // per phone, 15 min window
export const OTP_WINDOW_MS = 15 * 60 * 1000;

function pepper() {
  return process.env.OTP_PEPPER ?? config.jwtSecret ?? 'dev-only-pepper';
}

// 6-digit OTP, crypto-secure. 100000-999999 (leading zero nahi taaki
// SMS/voice me bolna-copy karna aasaan rahe). Generate = FREE.
export function generateOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

export function hashOtp(otp) {
  return crypto.createHmac('sha256', pepper()).update(String(otp)).digest('hex');
}

export function timingSafeEqualHex(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'hex');
  const bb = Buffer.from(String(b ?? ''), 'hex');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Sender: provider laga ho to usse bhejo, nahi to console log (Rs 0).
//   (a) MSG91 Flow API (recommended): OTP hum generate karte hain, MSG91
//       sirf DLT-approved template me SMS pahunchata hai. Verify logic
//       hamare paas rehta hai (MSG91 ka verify use nahi hota).
//       Env: OTP_SMS_PROVIDER=msg91 + OTP_MSG91_AUTHKEY + OTP_MSG91_FLOW_ID
//       + OTP_MSG91_SENDER (+ OTP_MSG91_OTP_VAR, default "OTP").
//       Flow panel me template me OTP variable + valid DLT zaroori hai,
//       warna MSG91 reject karega (paise tabhi kat-te hain jab SMS jaye).
//   (b) Generic webhook: OTP_SMS_URL=https://... (POST { to, text })
//       + OTP_SMS_KEY=... (Authorization: Bearer).
// Koi provider nahi hai -> Rs 0 kharch, dev me console + test me debug_otp.
export async function sendOtp(phone, otp, fetchFn = fetch) {
  const provider = (process.env.OTP_SMS_PROVIDER ?? '').trim().toLowerCase();
  if (provider === 'msg91') {
    const viaMsg91 = await sendViaMsg91(phone, otp, fetchFn);
    if (viaMsg91.delivered) return viaMsg91;
    // Fail ho to console fallback (OTP invalid nahi hota, retry ho sakta hai).
    logConsoleFallback(phone, otp);
    return { delivered: false, channel: 'console' };
  }
  const url = process.env.OTP_SMS_URL ?? '';
  if (url) {
    try {
      const key = process.env.OTP_SMS_KEY ?? '';
      const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(8000) : undefined;
      await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({ to: phone, text: `ApnaShift OTP: ${otp}. 10 min me use karo. Kisi se share mat karo.` }),
        ...(signal ? { signal } : {}),
      });
      return { delivered: true, channel: 'sms' };
    } catch (err) {
      // Provider fail ho to bhi OTP invalid nahi hota — console fallback
      // taaki user retry kar sake. Key/OTP kabhi log mat karo.
      console.error('[otp] sms provider fail:', err?.message ?? err);
    }
  }
  // Dev / zero-cost path — OTP value sirf NON-PROD console me (prod log
  // me sirf last-4 digits, PII kabhi nahi).
  logConsoleFallback(phone, otp);
  return { delivered: false, channel: 'console' };
}

function logConsoleFallback(phone, otp) {
  if (config.env !== 'production') {
    console.log(`[otp] dev OTP for ${phone}: ${otp} (SMS provider nahi laga — Rs 0)`);
  } else {
    console.log(`[otp] OTP generated for ending ${String(phone).slice(-4)}`);
  }
}

// MSG91 Flow API v5: POST https://api.msg91.com/api/v5/flow/
// { flow_id, sender, mobiles: "91XXXXXXXXXX", [otpVar]: otp }.
// Mobile hamesha country code samet (91 + 10-digit normalized phone).
async function sendViaMsg91(phone, otp, fetchFn) {
  const authkey = process.env.OTP_MSG91_AUTHKEY ?? '';
  const flowId = process.env.OTP_MSG91_FLOW_ID ?? '';
  const sender = process.env.OTP_MSG91_SENDER ?? '';
  const otpVar = process.env.OTP_MSG91_OTP_VAR ?? 'OTP';
  if (!authkey || !flowId || !sender) {
    // Adhuri config par SMS bhejne ki koshish bhi mat karo (paise/rate-limit
    // bachao) — seedha console fallback. Key kabhi log mat karo.
    console.error('[otp] msg91 config adhuri hai (AUTHKEY/FLOW_ID/SENDER chahiye).');
    return { delivered: false, channel: 'console' };
  }
  try {
    const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(8000) : undefined;
    const res = await fetchFn('https://api.msg91.com/api/v5/flow/', {
      method: 'POST',
      headers: {
        authkey,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        flow_id: flowId,
        sender,
        mobiles: `91${phone}`,
        [otpVar]: String(otp),
      }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      console.error(`[otp] msg91 HTTP ${res.status} — SMS nahi gaya.`);
      return { delivered: false, channel: 'msg91-sms' };
    }
    let type = '';
    try {
      const data = await res.json();
      type = data?.type ?? '';
    } catch {
      // Body parse na ho par HTTP OK ho to request accept mani jati hai.
    }
    if (type && type !== 'success') {
      console.error(`[otp] msg91 reject (type=${type}) — template/DLT check karo.`);
      return { delivered: false, channel: 'msg91-sms' };
    }
    return { delivered: true, channel: 'msg91-sms' };
  } catch (err) {
    console.error('[otp] msg91 fail:', err?.message ?? err);
    return { delivered: false, channel: 'msg91-sms' };
  }
}

// Test/dev me frontend bina SMS ke OTP dekh sake — sirf tab jab
// OTP_DEV_RETURN=1 ya NODE_ENV != production. Production me kabhi nahi.
export function shouldReturnDebugOtp() {
  if (process.env.OTP_DEV_RETURN === '1') return true;
  if (process.env.OTP_DEV_RETURN === '0') return false;
  return config.env !== 'production';
}
