// OTP sender unit tests — NO database, NO real SMS (fetch hamesha mocked).
// Run: npx vitest run tests/otp-send.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateOtp, hashOtp, timingSafeEqualHex, sendOtp } from '../src/services/otp.js';

const ENV_KEYS = [
  'OTP_SMS_PROVIDER',
  'OTP_MSG91_AUTHKEY',
  'OTP_MSG91_FLOW_ID',
  'OTP_MSG91_SENDER',
  'OTP_MSG91_OTP_VAR',
  'OTP_SMS_URL',
  'OTP_SMS_KEY',
];
let savedEnv = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function mockFetch(responder) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return responder(url, opts);
  };
  fn.calls = calls;
  return fn;
}

const okSuccess = () => ({ ok: true, status: 200, json: async () => ({ type: 'success' }) });

describe('otp generate/hash (no SMS)', () => {
  it('6-digit OTP, har baar alag (crypto)', () => {
    for (let i = 0; i < 20; i++) {
      expect(generateOtp()).toMatch(/^\d{6}$/);
    }
    const set = new Set(Array.from({ length: 20 }, () => generateOtp()));
    expect(set.size).toBeGreaterThan(1);
  });

  it('hash roundtrip + mismatch', () => {
    const h = hashOtp('123456');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(timingSafeEqualHex(h, hashOtp('123456'))).toBe(true);
    expect(timingSafeEqualHex(h, hashOtp('654321'))).toBe(false);
  });
});

describe('sendOtp console fallback (Rs 0)', () => {
  it('bina provider ke fetch call nahi hota', async () => {
    const fetchFn = mockFetch(okSuccess);
    const out = await sendOtp('9876543210', '123456', fetchFn);
    expect(out).toEqual({ delivered: false, channel: 'console' });
    expect(fetchFn.calls).toHaveLength(0);
  });
});

describe('sendOtp MSG91 Flow API', () => {
  beforeEach(() => {
    process.env.OTP_SMS_PROVIDER = 'msg91';
    process.env.OTP_MSG91_AUTHKEY = 'test-authkey';
    process.env.OTP_MSG91_FLOW_ID = 'flow-123';
    process.env.OTP_MSG91_SENDER = 'APNSHF';
  });

  it('sahi URL/headers/body: 91+number, flow vars', async () => {
    const fetchFn = mockFetch(okSuccess);
    const out = await sendOtp('9876543210', '482916', fetchFn);
    expect(out).toEqual({ delivered: true, channel: 'msg91-sms' });
    expect(fetchFn.calls).toHaveLength(1);
    const { url, opts } = fetchFn.calls[0];
    expect(url).toBe('https://api.msg91.com/api/v5/flow/');
    expect(opts.method).toBe('POST');
    expect(opts.headers.authkey).toBe('test-authkey');
    expect(opts.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(opts.body);
    expect(body.flow_id).toBe('flow-123');
    expect(body.sender).toBe('APNSHF');
    expect(body.mobiles).toBe('919876543210');
    expect(body.OTP).toBe('482916');
    // OTP kabhi key ke saath log nahi hota — body me key nahi honi chahiye.
    expect(JSON.stringify(body)).not.toContain('test-authkey');
  });

  it('custom OTP variable naam respect hota hai', async () => {
    process.env.OTP_MSG91_OTP_VAR = 'VAR1';
    const fetchFn = mockFetch(okSuccess);
    await sendOtp('9876543210', '111222', fetchFn);
    const body = JSON.parse(fetchFn.calls[0].opts.body);
    expect(body.VAR1).toBe('111222');
    expect(body.OTP).toBeUndefined();
  });

  it('adhuri config par fetch nahi hota (paise bachao)', async () => {
    delete process.env.OTP_MSG91_AUTHKEY;
    const fetchFn = mockFetch(okSuccess);
    const out = await sendOtp('9876543210', '123456', fetchFn);
    expect(out.delivered).toBe(false);
    expect(fetchFn.calls).toHaveLength(0);
  });

  it('HTTP fail par delivered=false', async () => {
    const fetchFn = mockFetch(() => ({ ok: false, status: 400, json: async () => ({}) }));
    const out = await sendOtp('9876543210', '123456', fetchFn);
    expect(out.delivered).toBe(false);
  });

  it('MSG91 reject (type != success) par delivered=false', async () => {
    const fetchFn = mockFetch(() => ({ ok: true, status: 200, json: async () => ({ type: 'error' }) }));
    const out = await sendOtp('9876543210', '123456', fetchFn);
    expect(out.delivered).toBe(false);
  });

  it('network throw par delivered=false (OTP valid rehta hai)', async () => {
    const fetchFn = mockFetch(() => {
      throw new Error('socket hang up');
    });
    const out = await sendOtp('9876543210', '123456', fetchFn);
    expect(out.delivered).toBe(false);
  });
});

describe('sendOtp generic webhook (backward compat)', () => {
  it('POST { to, text } + delivered=true', async () => {
    process.env.OTP_SMS_URL = 'https://example.com/hook';
    process.env.OTP_SMS_KEY = 'k';
    const fetchFn = mockFetch(okSuccess);
    const out = await sendOtp('9876543210', '123456', fetchFn);
    expect(out).toEqual({ delivered: true, channel: 'sms' });
    const body = JSON.parse(fetchFn.calls[0].opts.body);
    expect(body.to).toBe('9876543210');
    expect(body.text).toContain('123456');
  });
});
