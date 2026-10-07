// BookingNotify UX tests — stubbed browser globals, NO database, NO real
// notifications. Loads the REAL shipped notify.js and drives it.
// Run: npx vitest run tests/notify-ux.test.js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function loadNotify(stubs = {}) {
  const code = fs.readFileSync(path.join(root, '..', 'apnashift-frontend', 'notify.js'), 'utf8');
  const notifications = [];
  const store = {};
  const fakeWindow = {
    Notification: stubs.Notification,
    AudioContext: stubs.AudioContext,
    webkitAudioContext: stubs.webkitAudioContext,
    localStorage:
      stubs.localStorage !== undefined
        ? stubs.localStorage
        : {
            getItem: (k) => (k in store ? store[k] : null),
            setItem: (k, v) => {
              store[k] = String(v);
            },
          },
    ...(stubs.extra ?? {}),
  };
  const factory = new Function('window', `${code}; return window.BookingNotify;`);
  const api = factory(fakeWindow);
  api.__resetForTests();
  return { api, notifications, fakeWindow, store };
}

function grantedNotification(captured) {
  function N(title, opts) {
    captured.push({ title, opts });
    this.onclick = null;
  }
  N.permission = 'granted';
  N.requestPermission = async () => 'granted';
  return N;
}

describe('BookingNotify (stubbed browser)', () => {
  it('loads without window globals and never throws', () => {
    const { api } = loadNotify({ localStorage: null });
    expect(api.supported()).toBe(false);
    expect(api.permission()).toBe('unsupported');
    expect(api.notify({ title: 't', tag: 'x' })).toBe(false);
    expect(api.beep()).toBe(false);
    expect(api.loadPrefs()).toEqual({ alerts: false, sound: false });
    expect(api.savePrefs({ alerts: true })).toBe(false);
  });

  it('ensurePermission resolves safely in every state', async () => {
    const { api } = loadNotify({});
    expect(await api.ensurePermission()).toBe('unsupported');
    const denied = loadNotify({
      Notification: { permission: 'denied', requestPermission: async () => 'denied' },
    });
    expect(await denied.api.ensurePermission()).toBe('denied');
    const granted = loadNotify({
      Notification: { permission: 'granted', requestPermission: async () => 'granted' },
    });
    expect(await granted.api.ensurePermission()).toBe('granted');
  });

  it('notify passes title/body/tag through, dedupes by tag (no spam)', () => {
    const captured = [];
    const { api } = loadNotify({ Notification: grantedNotification(captured) });
    const first = api.notify({ title: 'New booking', body: 'mini_truck • Rs 610', tag: 'booking-1' });
    expect(first).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0].title).toBe('New booking');
    expect(captured[0].opts.body).toBe('mini_truck • Rs 610');
    expect(captured[0].opts.tag).toBe('booking-1');
    // Same order again -> suppressed.
    expect(api.notify({ title: 'New booking', body: 'mini_truck • Rs 610', tag: 'booking-1' })).toBe(
      false,
    );
    expect(captured).toHaveLength(1);
    // Different order -> delivered.
    expect(api.notify({ title: 'New booking', body: 'other', tag: 'booking-2' })).toBe(true);
    expect(captured).toHaveLength(2);
  });

  it('notify stays silent without granted permission', () => {
    const captured = [];
    function N() {
      captured.push(1);
    }
    N.permission = 'default';
    N.requestPermission = async () => 'default';
    const { api } = loadNotify({ Notification: N });
    expect(api.notify({ title: 't', tag: 'x' })).toBe(false);
    expect(captured).toHaveLength(0);
  });

  it('beep plays two-tone via WebAudio when available', () => {
    const played = [];
    function FakeAC() {}
    FakeAC.prototype.resume = async () => undefined;
    Object.defineProperty(FakeAC.prototype, 'currentTime', { value: 10 });
    FakeAC.prototype.createOscillator = function () {
      return { type: '', frequency: {}, connect() {}, start(t) { played.push(['start', t]); }, stop(t) { played.push(['stop', t]); } };
    };
    FakeAC.prototype.createGain = function () {
      return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
    };
    FakeAC.prototype.destination = {};
    const { api } = loadNotify({ AudioContext: FakeAC });
    expect(api.beep()).toBe(true);
    expect(played.length).toBeGreaterThan(0);
  });

  it('prefs round-trip, corrupt storage falls back safely', () => {
    const { api, store } = loadNotify({});
    expect(api.savePrefs({ alerts: true, sound: true })).toBe(true);
    expect(api.loadPrefs()).toEqual({ alerts: true, sound: true });
    store.apnashift_notify_prefs = 'not-json{{{';
    expect(api.loadPrefs()).toEqual({ alerts: false, sound: false });
  });
});
