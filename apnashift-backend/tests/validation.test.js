// Item 3: scheduled_time validation (DB nahi chahiye — zod schema direct).
// Past date -> fail, future/missing -> pass.
import { describe, it, expect } from 'vitest';
import { bookingCreateSchema } from '../src/validation/booking.js';

const base = {
  pickup: { address: '12 MG Road, Indore', lat: 22.72, lng: 75.86 },
  drop: { address: '45 AB Road, Indore', lat: 22.75, lng: 75.9 },
  vehicle_type: 'pickup',
};

describe('bookingCreateSchema.scheduled_time — past reject, future pass', () => {
  it('missing scheduled_time pass (optional)', () => {
    expect(bookingCreateSchema.safeParse(base).success).toBe(true);
  });
  it('future scheduled_time (kal) pass', () => {
    const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const r = bookingCreateSchema.safeParse({ ...base, scheduled_time: future });
    expect(r.success).toBe(true);
  });
  it('past scheduled_time (2000) fail', () => {
    const r = bookingCreateSchema.safeParse({ ...base, scheduled_time: '2000-01-01T00:00:00.000Z' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.join('.') === 'scheduled_time')).toBe(true);
    }
  });
  it('1 ghanta pehle fail (skew 60s se bahar)', () => {
    const past = new Date(Date.now() - 3600 * 1000).toISOString();
    expect(bookingCreateSchema.safeParse({ ...base, scheduled_time: past }).success).toBe(false);
  });
  it('galat format fail', () => {
    expect(
      bookingCreateSchema.safeParse({ ...base, scheduled_time: 'kal dopahar' }).success,
    ).toBe(false);
  });
});
