// Booking create/list ke zod schemas.
import { z } from 'zod';
import { parseBody as parseAuthBody } from './auth.js';

export { parseAuthBody as parseBody };

const latField = z
  .number({ invalid_type_error: 'lat number hona chahiye (-90 se 90).' })
  .min(-90, 'lat -90 se 90 ke beech.')
  .max(90, 'lat -90 se 90 ke beech.');

const lngField = z
  .number({ invalid_type_error: 'lng number hona chahiye (-180 se 180).' })
  .min(-180, 'lng -180 se 180 ke beech.')
  .max(180, 'lng -180 se 180 ke beech.');

const addressPointSchema = z.object({
  address: z
    .string({ required_error: 'Address likho.' })
    .trim()
    .min(3, 'Address kam se kam 3 akshar.')
    .max(300, 'Address 300 akshar se zyada nahi.'),
  lat: latField,
  lng: lngField,
});

// Public estimate endpoint ke liye (sirf coords, address nahi chahiye).
export const estimateSchema = z.object({
  pickup: z.object({ lat: latField, lng: lngField }),
  drop: z.object({ lat: latField, lng: lngField }),
  vehicle_type: z.enum(['pickup', 'mini_truck', 'mini_tractor'], {
    errorMap: () => ({ message: 'vehicle_type pickup, mini_truck ya mini_tractor ho.' }),
  }),
  helper_needed: z.boolean({ invalid_type_error: 'helper_needed true/false ho.' }).default(false),
});

export const bookingCreateSchema = z.object({
  pickup: addressPointSchema,
  drop: addressPointSchema,
  vehicle_type: z.enum(['pickup', 'mini_truck', 'mini_tractor'], {
    errorMap: () => ({ message: 'vehicle_type pickup, mini_truck ya mini_tractor ho.' }),
  }),
  helper_needed: z.boolean({ invalid_type_error: 'helper_needed true/false ho.' }).default(false),
  item_description: z
    .string()
    .trim()
    .max(500, 'Item detail 500 akshar se zyada nahi.')
    .optional()
    .default(''),
  // Optional ISO time. Client ka bheja price yahan field hi nahi hai —
  // price hamesha server ginata hai (route dekho), bheja hua ignore hoga.
  // Past date nahi: future ya abhi (60s skew chhoot ke saath).
  scheduled_time: z
    .string()
    .datetime({ message: 'scheduled_time ISO date-time ho.' })
    .refine((v) => new Date(v).getTime() >= Date.now() - 60 * 1000, {
      message: 'scheduled_time future me ho (past date nahi).',
    })
    .optional(),
});

export const driverStatusSchema = z.object({
  status: z.enum(['arrived', 'in_transit', 'delivered'], {
    errorMap: () => ({ message: 'status arrived, in_transit ya delivered ho.' }),
  }),
});

export const ratingSchema = z.object({
  stars: z
    .number({ invalid_type_error: 'stars 1 se 5 tak number ho.' })
    .int('stars poora number ho (1-5).')
    .min(1, 'stars kam se kam 1.')
    .max(5, 'stars zyada se zyada 5.'),
  comment: z
    .string()
    .trim()
    .max(500, 'Comment 500 akshar se zyada nahi.')
    .optional()
    .default(''),
});

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export function parseQuery(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const err = new Error('validation_failed');
    err.status = 400;
    err.details = result.error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    }));
    throw err;
  }
  return result.data;
}
