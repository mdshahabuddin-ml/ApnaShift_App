// Zod schemas for booking create/list.
import { z } from 'zod';
import { parseBody as parseAuthBody } from './auth.js';

export { parseAuthBody as parseBody };

const latField = z
  .number({ invalid_type_error: 'lat must be a number (-90 to 90).' })
  .min(-90, 'lat must be between -90 and 90.')
  .max(90, 'lat must be between -90 and 90.');

const lngField = z
  .number({ invalid_type_error: 'lng must be a number (-180 to 180).' })
  .min(-180, 'lng must be between -180 and 180.')
  .max(180, 'lng must be between -180 and 180.');

const addressPointSchema = z.object({
  address: z
    .string({ required_error: 'Enter the address.' })
    .trim()
    .min(3, 'Address must be at least 3 characters.')
    .max(300, 'Address must be no more than 300 characters.'),
  lat: latField,
  lng: lngField,
});

// Pricing v2 inputs (estimate + create share these; all optional with safe defaults
// so old clients keep working — server fills chhota/0/1/false).
const vehicleSizeTierField = z
  .enum(['chhota', 'bada'], {
    errorMap: () => ({ message: 'vehicle_size_tier must be chhota or bada.' }),
  })
  .default('chhota');
const goodsWeightField = z
  .number({ invalid_type_error: 'goods_weight_kg must be a number (kg).' })
  .min(0, 'goods_weight_kg must be at least 0.')
  .max(5000, 'goods_weight_kg must be no more than 5000 kg.')
  .default(0);
const itemCountField = z
  .number({ invalid_type_error: 'item_count must be a number.' })
  .int('item_count must be a whole number.')
  .min(1, 'item_count must be at least 1.')
  .max(100, 'item_count must be no more than 100.')
  .default(1);
const bulkyField = z
  .boolean({ invalid_type_error: 'has_bulky_item must be true or false.' })
  .default(false);

// For the public estimate endpoint (coords only, no address needed).
export const estimateSchema = z.object({
  pickup: z.object({ lat: latField, lng: lngField }),
  drop: z.object({ lat: latField, lng: lngField }),
  vehicle_type: z.enum(['pickup', 'mini_truck', 'mini_tractor'], {
    errorMap: () => ({ message: 'vehicle_type must be pickup, mini_truck, or mini_tractor.' }),
  }),
  helper_needed: z.boolean({ invalid_type_error: 'helper_needed must be true or false.' }).default(false),
  vehicle_size_tier: vehicleSizeTierField,
  goods_weight_kg: goodsWeightField,
  item_count: itemCountField,
  has_bulky_item: bulkyField,
});

export const bookingCreateSchema = z.object({
  pickup: addressPointSchema,
  drop: addressPointSchema,
  vehicle_type: z.enum(['pickup', 'mini_truck', 'mini_tractor'], {
    errorMap: () => ({ message: 'vehicle_type must be pickup, mini_truck, or mini_tractor.' }),
  }),
  helper_needed: z.boolean({ invalid_type_error: 'helper_needed must be true or false.' }).default(false),
  vehicle_size_tier: vehicleSizeTierField,
  goods_weight_kg: goodsWeightField,
  item_count: itemCountField,
  has_bulky_item: bulkyField,
  // UPI default; cash bhi chalega. 'online' reserved (gateway nahi hai).
  payment_method: z
    .enum(['cash', 'upi', 'online'], {
      errorMap: () => ({ message: 'payment_method must be cash, upi, or online.' }),
    })
    .default('upi'),
  // Items to Shift mandatory: kam se kam ek item + quantity (e.g. "2x Bed, 1x Sofa").
  // Frontend/Flutter serialize karte hain; backend sirf non-empty + length check karta hai.
  item_description: z
    .string({
      required_error:
        'Add at least one item to Items to Shift (e.g. 1 Bed, 2 Boxes) — with quantity.',
      invalid_type_error: 'item_description must be a string.',
    })
    .trim()
    .min(3, 'Add at least one item to Items to Shift (e.g. 1 Bed, 2 Boxes) — with quantity.')
    .max(500, 'Item description must be no more than 500 characters.'),
  // Optional ISO time. Client-sent price has no field here —
  // the server always computes price (see route); sent values are ignored.
  // No past dates: future or present (with 60s skew allowance).
  scheduled_time: z
    .string()
    .datetime({ message: 'scheduled_time must be an ISO date-time.' })
    .refine((v) => new Date(v).getTime() >= Date.now() - 60 * 1000, {
      message: 'scheduled_time must be in the future (not a past date).',
    })
    .optional(),
});

export const driverStatusSchema = z.object({
  status: z.enum(['arrived', 'in_transit', 'delivered'], {
    errorMap: () => ({ message: 'status must be arrived, in_transit, or delivered.' }),
  }),
});

// Customer cancellation reasons (fixed set — DB CHECK mirrors this list).
export const CANCEL_REASONS = [
  'wrong_pickup',
  'wrong_drop',
  'wrong_vehicle',
  'changed_plan',
  'duplicate',
  'driver_issue',
  'other',
];

export const cancelSchema = z.object({
  reason: z.enum(CANCEL_REASONS, {
    errorMap: () => ({ message: 'Select a cancellation reason (wrong_pickup, wrong_drop, wrong_vehicle, changed_plan, duplicate, driver_issue, other).' }),
  }),
});

export const ratingSchema = z.object({
  stars: z
    .number({ invalid_type_error: 'stars must be a number between 1 and 5.' })
    .int('stars must be a whole number (1-5).')
    .min(1, 'stars must be at least 1.')
    .max(5, 'stars must be at most 5.'),
  comment: z
    .string()
    .trim()
    .max(500, 'Comment must be no more than 500 characters.')
    .optional()
    .default(''),
});

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// POST /api/bookings/:id/flag-dispute — driver ya customer, reason required.
// Sirf flag hai; commission auto-change nahi hota.
export const disputeSchema = z.object({
  reason: z
    .string({ required_error: 'Enter a reason for the dispute.' })
    .trim()
    .min(3, 'Reason must be at least 3 characters.')
    .max(500, 'Reason must be no more than 500 characters.'),
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
