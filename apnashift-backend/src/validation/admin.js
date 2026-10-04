// Zod schemas for admin endpoints.
import { z } from 'zod';
import { BOOKING_STATUS } from '../services/bookingStatus.js';
import { parseQuery } from './booking.js';

const isoDate = z.string().datetime({ message: 'date ISO format me ho.' });

export const adminDriversQuerySchema = z.object({
  status: z.enum(['pending', 'verified', 'review'], {
    errorMap: () => ({ message: 'status pending, verified ya review ho.' }),
  }).default('pending'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const passwordResetSchema = z.object({
  new_password: z
    .string({ required_error: 'Naya password likho.' })
    .min(8, 'Password kam se kam 8 akshar.')
    .max(128, 'Password 128 akshar se zyada nahi.'),
});

export const driverRejectSchema = z.object({
  reason: z
    .string({ required_error: 'Reject ki wajah (reason) likho.' })
    .trim()
    .min(3, 'Wajah kam se kam 3 akshar.')
    .max(500, 'Wajah 500 akshar se zyada nahi.'),
});

export const adminBookingsQuerySchema = z.object({
  status: z.enum(BOOKING_STATUS, {
    errorMap: () => ({ message: 'status sahi booking status ho.' }),
  }).optional(),
  disputed: z.preprocess(
    (v) => (v === 'true' ? true : v === 'false' ? false : v),
    z.boolean({ invalid_type_error: 'disputed true/false ho.' }).optional(),
  ),
  from: isoDate.optional(),
  to: isoDate.optional(),
  city: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const bookingAssignSchema = z.object({
  driver_id: z.string({ required_error: 'driver_id likho.' }).uuid('driver_id UUID ho.'),
});

const rateField = z.number({ invalid_type_error: 'rate number ho.' }).min(0, 'rate 0 se kam nahi.');

export const pricingUpdateSchema = z
  .object({
    vehicle_type: z.enum(['pickup', 'mini_truck', 'mini_tractor'], {
      errorMap: () => ({ message: 'vehicle_type pickup, mini_truck ya mini_tractor ho.' }),
    }),
    base_rs: rateField.optional(),
    per_km_rs: rateField.optional(),
    helper_rs: rateField.optional(),
    // Per-vehicle commission % (snapshot into bookings at creation).
    commission_pct: z
      .number({ invalid_type_error: 'commission_pct number ho (0-100).' })
      .min(0, 'commission_pct 0 se kam nahi.')
      .max(100, 'commission_pct 100 se zyada nahi.')
      .refine((v) => Math.round(v * 100) === v * 100, {
        message: 'commission_pct me zyada se zyada 2 decimal ho.',
      })
      .optional(),
  })
  .refine(
    (v) =>
      v.base_rs !== undefined ||
      v.per_km_rs !== undefined ||
      v.helper_rs !== undefined ||
      v.commission_pct !== undefined,
    {
      message: 'Kam se kam ek rate badlo (base_rs, per_km_rs, helper_rs ya commission_pct).',
    },
  );

export const pricingHistoryQuerySchema = z.object({
  vehicle_type: z.enum(['pickup', 'mini_truck', 'mini_tractor']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export { parseQuery };
