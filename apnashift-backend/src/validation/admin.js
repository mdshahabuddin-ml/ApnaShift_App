// Zod schemas for admin endpoints.
import { z } from 'zod';
import { BOOKING_STATUS } from '../services/bookingStatus.js';
import { parseQuery } from './booking.js';

const isoDate = z.string().datetime({ message: 'date must be in ISO format.' });

export const adminDriversQuerySchema = z.object({
  status: z.enum(['pending', 'verified', 'review'], {
    errorMap: () => ({ message: 'status must be pending, verified, or review.' }),
  }).default('pending'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const passwordResetSchema = z.object({
  new_password: z
    .string({ required_error: 'Enter a new password.' })
    .min(8, 'Password must be at least 8 characters.')
    .max(128, 'Password must be no more than 128 characters.'),
});

export const driverRejectSchema = z.object({
  reason: z
    .string({ required_error: 'Enter a reason for rejection.' })
    .trim()
    .min(3, 'Reason must be at least 3 characters.')
    .max(500, 'Reason must be no more than 500 characters.'),
});

export const adminBookingsQuerySchema = z.object({
  status: z.enum(BOOKING_STATUS, {
    errorMap: () => ({ message: 'status must be a valid booking status.' }),
  }).optional(),
  disputed: z.preprocess(
    (v) => (v === 'true' ? true : v === 'false' ? false : v),
    z.boolean({ invalid_type_error: 'disputed must be true or false.' }).optional(),
  ),
  from: isoDate.optional(),
  to: isoDate.optional(),
  city: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const bookingAssignSchema = z.object({
  driver_id: z.string({ required_error: 'Enter driver_id.' }).uuid('driver_id must be a UUID.'),
});

const rateField = z.number({ invalid_type_error: 'rate must be a number.' }).min(0, 'rate must be at least 0.');

export const pricingUpdateSchema = z
  .object({
    vehicle_type: z.enum(['pickup', 'mini_truck', 'mini_tractor'], {
      errorMap: () => ({ message: 'vehicle_type must be pickup, mini_truck, or mini_tractor.' }),
    }),
    base_rs: rateField.optional(),
    per_km_rs: rateField.optional(),
    helper_rs: rateField.optional(),
    minimum_fare: rateField.optional(),
    size_small_extra: rateField.optional(),
    size_big_extra: rateField.optional(),
    weight_0_100: rateField.optional(),
    weight_100_300: rateField.optional(),
    weight_300_500: rateField.optional(),
    weight_500_plus: rateField.optional(),
    // Per-vehicle commission % (snapshot into bookings at creation).
    commission_pct: z
      .number({ invalid_type_error: 'commission_pct must be a number (0-100).' })
      .min(0, 'commission_pct must be at least 0.')
      .max(100, 'commission_pct must be no more than 100.')
      .refine((v) => Math.round(v * 100) === v * 100, {
        message: 'commission_pct must have at most 2 decimal places.',
      })
      .optional(),
  })
  .refine(
    (v) =>
      v.base_rs !== undefined ||
      v.per_km_rs !== undefined ||
      v.helper_rs !== undefined ||
      v.minimum_fare !== undefined ||
      v.size_small_extra !== undefined ||
      v.size_big_extra !== undefined ||
      v.weight_0_100 !== undefined ||
      v.weight_100_300 !== undefined ||
      v.weight_300_500 !== undefined ||
      v.weight_500_plus !== undefined ||
      v.commission_pct !== undefined,
    {
      message:
        'Change at least one rate (base_rs, per_km_rs, helper_rs, minimum_fare, size_small_extra, size_big_extra, weight_0_100, weight_100_300, weight_300_500, weight_500_plus, or commission_pct).',
    },
  );

export const pricingHistoryQuerySchema = z.object({
  vehicle_type: z.enum(['pickup', 'mini_truck', 'mini_tractor']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// GET /api/admin/reports/summary — from/to accept YYYY-MM-DD (poora din)
// ya full ISO datetime. Date-only `to` din ke aakhir tak (23:59:59.999).
function toRangeISO(v, endOfDay) {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return s;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return s;
  return endOfDay ? new Date(dt.getTime() + 86400000 - 1).toISOString() : dt.toISOString();
}

const reportDateInput = (field, endOfDay) =>
  z.preprocess(
    (v) => {
      if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return undefined;
      return toRangeISO(v, endOfDay);
    },
    z.string().datetime({ message: `${field} must be in YYYY-MM-DD or ISO datetime format.` }).optional(),
  );

export const reportsSummaryQuerySchema = z
  .object({
    from: reportDateInput('from', false),
    to: reportDateInput('to', true),
    group_by: z
      .enum(['day', 'week', 'month'], {
        errorMap: () => ({ message: 'group_by must be day, week, or month.' }),
      })
      .default('day'),
  })
  .refine((v) => !(v.from && v.to) || new Date(v.from).getTime() <= new Date(v.to).getTime(), {
    message: 'from must be before or equal to to.',
    path: ['from'],
  })
  .refine(
    (v) => {
      if (!v.from || !v.to) return true;
      return new Date(v.to).getTime() - new Date(v.from).getTime() <= 366 * 86400000;
    },
    { message: 'Range must be no more than 366 days.', path: ['to'] },
  );

export { parseQuery };
