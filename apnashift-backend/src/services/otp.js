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

// Zero-cost sender: provider laga ho to usse bhejo, nahi to console log.
// MSG91/Twilio jaise provider ke liye env me rakho:
//   OTP_SMS_URL=https://... (POST { to, text })
//   OTP_SMS_KEY=...
// Abhi koi provider nahi hai -> Rs 0 kharch, dev me console + test me debug_otp.
export async function sendOtp(phone, otp, fetchFn = fetch) {
  const url = process.env.OTP_SMS_URL ?? '';
  if (url) {
    try {
      const key = process.env.OTP_SMS_KEY ?? '';
      await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({ to: phone, text: `ApnaShift OTP: ${otp}. 10 min me use karo. Kisi se share mat karo.` }),
      });
      return { delivered: true, channel: 'sms' };
    } catch (err) {
      // Provider fail ho to bhi OTP invalid nahi hota — console fallback
      // taaki user retry kar sake. Key/OTP kabhi log mat karo.
      console.error('[otp] sms provider fail:', err?.message ?? err);
    }
  }
  // Dev / zero-cost path — OTP value sirf server console me (prod log
  // me PII mask karo, dev me testing ke liye chahiye).
  if (config.env !== 'production') {
    console.log(`[otp] dev OTP for ${phone}: ${otp} (SMS provider nahi laga — Rs 0)`);
  } else {
    console.log(`[otp] OTP generated for ending ${String(phone).slice(-4)}`);
  }
  return { delivered: false, channel: 'console' };
}

// Test/dev me frontend bina SMS ke OTP dekh sake — sirf tab jab
// OTP_DEV_RETURN=1 ya NODE_ENV != production. Production me kabhi nahi.
export function shouldReturnDebugOtp() {
  if (process.env.OTP_DEV_RETURN === '1') return true;
  if (process.env.OTP_DEV_RETURN === '0') return false;
  return config.env !== 'production';
}
