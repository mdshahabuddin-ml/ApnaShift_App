// WhatsApp booking foundation — NO Meta credentials required.
//
// Layers:
//   1. Provider adapter (this file): sendMessage + booking/customer texts.
//      'mock' records into an in-memory outbox (local tests read it);
//      anything else drops outbound text with a log line (never throws,
//      so dialog + booking flow work without credentials).
//   2. Conversation state machine (this file): START -> PICKUP -> DROP ->
//      VEHICLE -> DATE_TIME -> PAYMENT -> CONFIRMATION -> BOOKING_CREATED.
//      State lives in wa_conversations (survives restarts); duplicate
//      confirmations can never mint two bookings (consumed flag pattern).
//   3. HTTP webhook (routes/whatsapp.js): thin translate + orchestrate.
//
// Reuses: booking core (services/bookings.js), Geoapify autocomplete,
// SSE notify fns, audit. No duplicate booking/notification/tracking code.
import { query } from '../db.js';
import { normalizePhone, PHONE_RE } from '../utils/phone.js';
import { geoapifyAutocomplete } from './geoapify.js';
import { createBookingRow } from './bookings.js';

export const WA_STATES = [
  'START',
  'PICKUP',
  'DROP',
  'VEHICLE',
  'DATE_TIME',
  'PAYMENT',
  'CONFIRMATION',
  'BOOKING_CREATED',
];

export const WA_VEHICLES = ['pickup', 'mini_truck', 'mini_tractor'];
export const WA_PAYMENTS = ['cash', 'upi'];

function activeProvider() {
  const raw = process.env.WHATSAPP_PROVIDER ?? '';
  if (raw !== '') return raw.trim().toLowerCase();
  // Local/dev convenience: mock. Production default: none (drop + log).
  return process.env.NODE_ENV === 'production' ? 'none' : 'mock';
}

// ---- Provider adapter interface ----
const mockOutbox = [];

export function mockOutboxList() {
  return mockOutbox;
}

export function clearMockOutbox() {
  mockOutbox.length = 0;
}

function maskPhone(phone) {
  const p = String(phone ?? '');
  return p.length > 4 ? `***${p.slice(-4)}` : '***';
}

export async function sendMessage(to, text) {
  const provider = activeProvider();
  if (provider === 'mock') {
    mockOutbox.push({ to: String(to), text: String(text), at: new Date().toISOString() });
    return { ok: true, channel: 'mock' };
  }
  console.log(`[wa:${provider || 'none'}] outbound to ${maskPhone(to)} suppressed (no credentials).`);
  return { ok: false, channel: provider || 'none' };
}

export async function sendBookingConfirmation(to, { bookingId, fareRs, paymentMethod }) {
  return sendMessage(
    to,
    `ApnaShift booking pakki! ID: ${bookingId} • Kiraya Rs ${fareRs} • ` +
      `${paymentMethod === 'cash' ? 'Cash driver ko dena' : 'Online (UPI) se dena'}. ` +
      `Driver milte hi khabar milegi.`,
  );
}

export async function sendDriverAssigned(to, { bookingId, driverName }) {
  return sendMessage(
    to,
    `Driver mil gaya! Booking ${bookingId} par ${driverName} aa rahe hain. Live tracking app me dekho.`,
  );
}

export async function sendDriverArriving(to, { bookingId }) {
  return sendMessage(to, `Driver paas pahunch raha hai (booking ${bookingId}). Taiyaar raho.`);
}

export async function sendBookingCompleted(to, { bookingId, fareRs }) {
  return sendMessage(
    to,
    `Trip poori ho gayi! Booking ${bookingId} • Kul Rs ${fareRs}. Rating dena na bhoolo. Dhanyavaad!`,
  );
}

// ---- Conversation state machine ----
async function defaultGeocode(address) {
  const results = await geoapifyAutocomplete(String(address), 3);
  const first = results[0];
  // geoapifyAutocomplete returns { lat, lng }; accept lon too (defensive).
  const lng = typeof first?.lon === 'number' ? first.lon : first?.lng;
  if (!first || typeof first.lat !== 'number' || typeof lng !== 'number') return null;
  return { lat: first.lat, lng, formatted: first.formatted ?? String(address) };
}

async function findUserByPhone(phone) {
  const found = await query('SELECT id, name, phone FROM users WHERE phone = $1', [phone]);
  return found.rowCount > 0 ? found.rows[0] : null;
}

async function loadConversation(phone) {
  const found = await query('SELECT * FROM wa_conversations WHERE phone = $1', [phone]);
  if (found.rowCount > 0) return found.rows[0];
  const created = await query(
    `INSERT INTO wa_conversations (phone, state, data) VALUES ($1, 'START', '{}') RETURNING *`,
    [phone],
  );
  return created.rows[0];
}

async function saveConversation(phone, state, data, bookingId = null) {
  const params = [state, JSON.stringify(data ?? {}), phone];
  if (bookingId === null) {
    await query(
      `UPDATE wa_conversations SET state = $1, data = $2, updated_at = now() WHERE phone = $3`,
      params,
    );
  } else {
    await query(
      `UPDATE wa_conversations SET state = $1, data = $2, booking_id = $4, updated_at = now() WHERE phone = $3`,
      [state, JSON.stringify(data ?? {}), phone, bookingId],
    );
  }
}

function norm(s) {
  return String(s ?? '').trim().toLowerCase();
}

function parseVehicle(text) {
  const t = norm(text).replace(/[\s_]+/g, '');
  if (t.includes('pickup')) return 'pickup';
  if (t.includes('minitruck') || t.includes('truck')) return 'mini_truck';
  if (t.includes('minitractor') || t.includes('tractor')) return 'mini_tractor';
  return null;
}

function parsePayment(text) {
  const t = norm(text);
  if (/(^|\W)(cash|cod|nakad|nagad)(\W|$)/.test(t)) return 'cash';
  if (/(^|\W)(upi|online|gpay|phonepe|paytm)(\W|$)/.test(t)) return 'upi';
  return null;
}

function parseDateTime(text) {
  const t = norm(text);
  if (/^(now|abhi|aaj|turant|asap)$/.test(t)) return { scheduledAt: null };
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])));
  if (
    dt.getUTCFullYear() !== Number(m[1]) ||
    dt.getUTCMonth() !== Number(m[2]) - 1 ||
    dt.getUTCDate() !== Number(m[3]) ||
    dt.getTime() <= Date.now()
  ) {
    return null;
  }
  return { scheduledAt: dt.toISOString() };
}

function summaryText(d) {
  return (
    `Booking summary:\nPickup: ${d.pickup.address}\nDrop: ${d.drop.address}\n` +
    `Gaadi: ${d.vehicle}\nSamay: ${d.scheduledAt ? d.scheduledAt : 'Abhi'}\n` +
    `Payment: ${d.payment === 'cash' ? 'Cash (COD)' : 'Online (UPI)'}\n` +
    `Confirm karne ke liye YES likho, badalne ke liye NO likho.`
  );
}

// Returns { reply, created, bookingRow?, user? }. Never throws for bad
// input — it replies with a reprompt instead (WhatsApp UX has no 400s).
// deps override for tests: { geocode(address)->{lat,lng,formatted}|null }.
export async function handleWaMessage({ phone, text }, deps = {}) {
  const geocode = deps.geocode ?? defaultGeocode;
  const clean = normalizePhone(phone);
  if (!PHONE_RE.test(clean)) {
    return { reply: 'ApnaShift: sahi 10-digit mobile number se message karo.', created: false };
  }
  const user = await findUserByPhone(clean);
  if (!user) {
    return {
      reply:
        'ApnaShift me is number se account nahi mila. Pehle app/website par register karo, phir yahan booking likho.',
      created: false,
    };
  }

  let convo = await loadConversation(clean);
  let data = convo.data && typeof convo.data === 'object' ? convo.data : {};
  // Fresh message after a finished booking starts a new dialog (same text
  // is then treated as the pickup answer — no input wasted, no double book).
  let state = convo.state;
  if (state === 'BOOKING_CREATED') {
    state = 'PICKUP';
  }

  const raw = String(text ?? '').trim();
  const setState = async (next, nextData = data, bookingId = null) => {
    await saveConversation(clean, next, nextData, bookingId);
  };

  if (state === 'START' || (state === 'PICKUP' && convo.state === 'BOOKING_CREATED')) {
    if (state === 'START') {
      data = {};
      await setState('PICKUP', data);
      return {
        reply: `Namaste ${user.name}! ApnaShift WhatsApp booking me swagat hai. Pickup address bhejo.`,
        created: false,
      };
    }
    // else: recycled BOOKING_CREATED message falls into PICKUP below.
  }

  if (state === 'PICKUP') {
    if (raw.length < 3) {
      return { reply: 'Pickup address thoda detail me likho (jaise: 12 MG Road, Indore).', created: false };
    }
    let geo = null;
    try {
      geo = await geocode(raw);
    } catch {
      // Geocode fail -> geo null rehta hai (neeche reprompt).
    }
    if (!geo) {
      return { reply: 'Ye pickup address nahi mila. Sahi spelling/area ke saath dobara bhejo.', created: false };
    }
    data = { ...data, pickup: { address: raw, lat: geo.lat, lng: geo.lng, formatted: geo.formatted } };
    await setState('DROP', data);
    return { reply: `Pickup set: ${geo.formatted}. Ab drop address bhejo.`, created: false };
  }

  if (state === 'DROP') {
    if (raw.length < 3) {
      return { reply: 'Drop address thoda detail me likho.', created: false };
    }
    let geo = null;
    try {
      geo = await geocode(raw);
    } catch {
      // Geocode fail -> geo null rehta hai (neeche reprompt).
    }
    if (!geo) {
      return { reply: 'Ye drop address nahi mila. Sahi spelling/area ke saath dobara bhejo.', created: false };
    }
    data = { ...data, drop: { address: raw, lat: geo.lat, lng: geo.lng, formatted: geo.formatted } };
    await setState('VEHICLE', data);
    return { reply: 'Gaadi chuno: pickup, mini_truck ya mini_tractor likho.', created: false };
  }

  if (state === 'VEHICLE') {
    const vehicle = parseVehicle(raw);
    if (!vehicle) {
      return { reply: 'Samajh nahi aaya. pickup, mini_truck ya mini_tractor me se ek likho.', created: false };
    }
    data = { ...data, vehicle };
    await setState('DATE_TIME', data);
    return { reply: 'Kab chahiye? "now" likho ya "YYYY-MM-DD HH:mm" me future time bhejo.', created: false };
  }

  if (state === 'DATE_TIME') {
    const parsed = parseDateTime(raw);
    if (!parsed) {
      return { reply: 'Samay samajh nahi aaya. "now" likho ya future time "YYYY-MM-DD HH:mm" me bhejo.', created: false };
    }
    data = { ...data, scheduledAt: parsed.scheduledAt };
    await setState('PAYMENT', data);
    return { reply: 'Payment kaise karoge? cash (COD) ya upi (Online) likho.', created: false };
  }

  if (state === 'PAYMENT') {
    const payment = parsePayment(raw);
    if (!payment) {
      return { reply: 'cash ya upi me se ek likho.', created: false };
    }
    data = { ...data, payment };
    await setState('CONFIRMATION', data);
    return { reply: summaryText(data), created: false };
  }

  if (state === 'CONFIRMATION') {
    const t = norm(raw);
    if (/^(yes|haan|han|y|confirm|ok)$/.test(t)) {
      let row;
      try {
        row = await createBookingRow(query, {
          userId: user.id,
          vehicleType: data.vehicle,
          pickup: data.pickup,
          drop: data.drop,
          helperNeeded: false,
          itemDescription: '',
          scheduledAt: data.scheduledAt,
          paymentMethod: data.payment,
          source: 'WHATSAPP',
        });
      } catch (err) {
        // e.g. route too long: back to start, booking row untouched.
        data = {};
        await setState('START', data);
        return {
          reply: 'Ye route hamari service se bahar hai. Nayi booking ke liye HI likho.',
          created: false,
        };
      }
      await setState('BOOKING_CREATED', data, row.id);
      return { reply: '', created: true, bookingRow: row, user };
    }
    if (/^(no|nahi|nahin|n|cancel|radd)$/.test(t)) {
      data = {};
      await setState('START', data);
      return { reply: 'Booking cancel kar di. Nayi booking ke liye HI likho.', created: false };
    }
    return { reply: `${summaryText(data)}`, created: false };
  }

  // Unknown state (should not happen): reset cleanly, never crash.
  data = {};
  await setState('START', data);
  return { reply: 'Namaste! Nayi booking ke liye HI likho.', created: false };
}
