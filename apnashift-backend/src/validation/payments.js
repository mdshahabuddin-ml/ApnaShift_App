// Zod schemas for payments/commission/settlements/adjustments.
// Amounts arrive as rupees numbers (existing API convention: price_rs);
// backend converts to integer paise immediately (services/money.js).
// Commission pct is 0..100 with max 2 decimals (matches NUMERIC(5,2)).
import { z } from 'zod';
import { parseBody as parseAuthBody } from './auth.js';
import { parseQuery } from './booking.js';

export { parseAuthBody as parseBody, parseQuery };

export const PAYMENT_METHODS = ['cash', 'online'];

export const paymentMethodField = z.enum(PAYMENT_METHODS, {
  errorMap: () => ({ message: 'payment_method cash ya online ho.' }),
});

const amountRs = z
  .number({ invalid_type_error: 'amount number ho.' })
  .positive('amount 0 se zyada ho.')
  .max(10000000, 'amount bahut zyada hai.');

export const commissionUpdateSchema = z.object({
  pct: z
    .number({ invalid_type_error: 'pct number ho (0-100).' })
    .min(0, 'pct 0 se kam nahi.')
    .max(100, 'pct 100 se zyada nahi.')
    .refine((v) => Math.round(v * 100) === v * 100, {
      message: 'pct me zyada se zyada 2 decimal ho.',
    }),
});

export const settlementCreateSchema = z.object({
  driver_id: z.string({ required_error: 'driver_id likho.' }).uuid('driver_id UUID ho.'),
  amount_rs: amountRs,
  method: z.enum(['cash', 'bank_transfer', 'upi'], {
    errorMap: () => ({ message: 'method cash, bank_transfer ya upi ho.' }),
  }),
  // Reference jahan applicable (bank/upi par required, cash par optional).
  reference_no: z
    .string()
    .trim()
    .min(2, 'reference_no kam se kam 2 akshar.')
    .max(100, 'reference_no 100 akshar se zyada nahi.')
    .optional(),
  notes: z.string().trim().max(500, 'notes 500 akshar se zyada nahi.').optional(),
  settled_at: z.string().datetime({ message: 'settled_at ISO date-time ho.' }).optional(),
}).refine(
  (v) => v.method === 'cash' || (v.reference_no && v.reference_no.length >= 2),
  { message: 'bank_transfer/upi par reference_no zaroori hai.', path: ['reference_no'] },
);

export const adjustmentCreateSchema = z.object({
  payment_id: z.string({ required_error: 'payment_id likho.' }).uuid('payment_id UUID ho.'),
  // Signed integer paise deltas (corrections, append-only).
  commission_delta_paise: z
    .number({ invalid_type_error: 'commission_delta_paise integer paise ho.' })
    .int('commission_delta_paise poora number ho.')
    .optional()
    .default(0),
  earning_delta_paise: z
    .number({ invalid_type_error: 'earning_delta_paise integer paise ho.' })
    .int('earning_delta_paise poora number ho.')
    .optional()
    .default(0),
  reason: z
    .string({ required_error: 'Adjustment ki wajah (reason) likho.' })
    .trim()
    .min(3, 'Wajah kam se kam 3 akshar.')
    .max(500, 'Wajah 500 akshar se zyada nahi.'),
}).refine((v) => v.commission_delta_paise !== 0 || v.earning_delta_paise !== 0, {
  message: 'Kam se kam ek delta non-zero ho.',
});

export const ledgerQuerySchema = z.object({
  driver_id: z.string().uuid('driver_id UUID ho.').optional(),
  status: z.enum(['owed', 'partial', 'settled']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const settlementsQuerySchema = z.object({
  driver_id: z.string().uuid('driver_id UUID ho.').optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
