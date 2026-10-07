// WhatsApp webhook (Meta-ready, no credentials required).
// Inbound shape is provider-normalized { from, text } — the future Meta
// adapter will translate Meta's entry/changes payload into this shape,
// so this route never changes when the real provider plugs in.
// Public (Meta calls it): rate-limited, no JWT. Secrets never in/out.
import { Router } from 'express';
import { toPublicBooking, newBookingEvent, adminBookingEvent } from './bookings.js';
import { publishNewBooking, publishAdminBooking } from '../services/tracking.js';
import { logAuditSafe } from '../services/audit.js';
import { handleWaMessage, sendBookingConfirmation } from '../services/whatsapp.js';
import { writeLimiter } from '../middleware/writeLimiter.js';

export const whatsappRoutes = Router();

// GET /api/whatsapp/webhook — Meta verify handshake (future use).
// Without WHATSAPP_VERIFY_TOKEN configured this stays 403 by design.
whatsappRoutes.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expected = process.env.WHATSAPP_VERIFY_TOKEN ?? '';
  if (
    mode === 'subscribe' &&
    expected !== '' &&
    token === expected &&
    typeof challenge === 'string' &&
    challenge !== ''
  ) {
    res.status(200).type('text/plain').send(challenge);
    return;
  }
  res.status(403).json({ ok: false, error: 'forbidden' });
});

// POST /api/whatsapp/webhook { from, text } — dialog + booking + notify.
// Always 200 for well-formed input (WhatsApp UX has no error codes);
// malformed bodies get 400 without touching any state.
whatsappRoutes.post('/webhook', writeLimiter, async (req, res, next) => {
  try {
    const from = typeof req.body?.from === 'string' ? req.body.from : '';
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    if (!from.trim() || !text.trim() || text.length > 2000) {
      return res.status(400).json({ ok: false, error: 'validation_failed' });
    }
    const out = await handleWaMessage({ phone: from, text });
    if (!out.created) {
      return res.json({ ok: true, reply: out.reply });
    }
    const pub = toPublicBooking(out.bookingRow);
    publishNewBooking(out.bookingRow.vehicle_type, newBookingEvent(out.bookingRow));
    publishAdminBooking('new_booking', await adminBookingEvent(out.bookingRow));
    await logAuditSafe(null, 'booking.created', 'booking', out.bookingRow.id, {
      user_id: out.user.id,
      vehicle_type: pub.vehicle_type,
      price_rs: pub.price_rs,
    });
    await sendBookingConfirmation(out.user.phone, {
      bookingId: pub.id,
      fareRs: pub.price_rs,
      paymentMethod: pub.payment_method,
    });
    res.json({
      ok: true,
      booking: pub,
      reply: `Booking pakki! ID: ${pub.id}`,
    });
  } catch (err) {
    next(err);
  }
});
