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
  errorMap: () => ({ message: 'payment_method must be cash or online.' }),
});

const amountRs = z
  .number({ invalid_type_error: 'amount must be a number.' })
  .positive('amount must be greater than 0.')
  .max(10000000, 'amount is too high.');

export const commissionUpdateSchema = z.object({
  pct: z
    .number({ invalid_type_error: 'pct must be a number (0-100).' })
    .min(0, 'pct must be at least 0.')
    .max(100, 'pct must be no more than 100.')
    .refine((v) => Math.round(v * 100) === v * 100, {
      message: 'pct must have at most 2 decimal places.',
    }),
});

export const settlementCreateSchema = z.object({
  driver_id: z.string({ required_error: 'Enter driver_id.' }).uuid('driver_id must be a UUID.'),
  amount_rs: amountRs,
  method: z.enum(['cash', 'bank_transfer', 'upi'], {
    errorMap: () => ({ message: 'method must be cash, bank_transfer, or upi.' }),
  }),
  // Reference jahan applicable (bank/upi par required, cash par optional).
  reference_no: z
    .string()
    .trim()
    .min(2, 'reference_no must be at least 2 characters.')
    .max(100, 'reference_no must be no more than 100 characters.')
    .optional(),
  notes: z.string().trim().max(500, 'notes must be no more than 500 characters.').optional(),
  settled_at: z.string().datetime({ message: 'settled_at must be an ISO date-time.' }).optional(),
}).refine(
  (v) => v.method === 'cash' || (v.reference_no && v.reference_no.length >= 2),
  { message: 'reference_no is required for bank_transfer/upi.', path: ['reference_no'] },
);

export const settleCommissionSchema = z
  .object({
    amount_rs: amountRs,
    note: z.string().trim().max(500, 'note must be no more than 500 characters.').optional(),
    method: z
      .enum(['cash', 'bank_transfer', 'upi'], {
        errorMap: () => ({ message: 'method must be cash, bank_transfer, or upi.' }),
      })
      .optional()
      .default('cash'),
    reference_no: z
      .string()
      .trim()
      .min(2, 'reference_no must be at least 2 characters.')
      .max(100, 'reference_no must be no more than 100 characters.')
      .optional(),
  })
  .refine((v) => v.method === 'cash' || (v.reference_no && v.reference_no.length >= 2), {
    message: 'reference_no is required for bank_transfer/upi.',
    path: ['reference_no'],
  });

export const adjustmentCreateSchema = z.object({
  payment_id: z.string({ required_error: 'Enter payment_id.' }).uuid('payment_id must be a UUID.'),
  // Signed integer paise deltas (corrections, append-only).
  commission_delta_paise: z
    .number({ invalid_type_error: 'commission_delta_paise must be integer paise.' })
    .int('commission_delta_paise must be a whole number.')
    .optional()
    .default(0),
  earning_delta_paise: z
    .number({ invalid_type_error: 'earning_delta_paise must be integer paise.' })
    .int('earning_delta_paise must be a whole number.')
    .optional()
    .default(0),
  reason: z
    .string({ required_error: 'Enter a reason for the adjustment.' })
    .trim()
    .min(3, 'Reason must be at least 3 characters.')
    .max(500, 'Reason must be no more than 500 characters.'),
}).refine((v) => v.commission_delta_paise !== 0 || v.earning_delta_paise !== 0, {
  message: 'At least one delta must be non-zero.',
});

export const ledgerQuerySchema = z.object({
  driver_id: z.string().uuid('driver_id must be a UUID.').optional(),
  status: z.enum(['owed', 'partial', 'settled']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const settlementsQuerySchema = z.object({
  driver_id: z.string().uuid('driver_id must be a UUID.').optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
