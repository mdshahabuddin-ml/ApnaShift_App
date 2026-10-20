// Zod schemas for COD confirm + weekly settlement periods.
// Amounts arrive as rupees numbers (existing API convention); backend
// converts to integer paise immediately (services/money.js).
import { z } from 'zod';
import { parseBody as parseAuthBody, parseQuery } from './payments.js';

export { parseAuthBody as parseBody, parseQuery };

// YYYY-MM-DD Monday (service re-checks Monday-ness -> 400 invalid_week).
const weekStartField = z
  .string({ required_error: 'Enter week_start (YYYY-MM-DD, Monday).' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'week_start must be in YYYY-MM-DD format.' });

const amountRs = z
  .number({ invalid_type_error: 'amount must be a number.' })
  .positive('amount must be greater than 0.')
  .max(10000000, 'amount is too high.');

export const periodGenerateSchema = z.object({
  driver_id: z.string().uuid('driver_id must be a UUID.').optional(),
  week_start: weekStartField.optional(),
});

export const periodPaySchema = z.object({
  amount_rs: amountRs,
  method: z.enum(['cash', 'bank_transfer', 'upi'], {
    errorMap: () => ({ message: 'method must be cash, bank_transfer, or upi.' }),
  }),
  reference_no: z
    .string()
    .trim()
    .min(2, 'reference_no must be at least 2 characters.')
    .max(100, 'reference_no must be no more than 100 characters.')
    .optional(),
  notes: z.string().trim().max(500, 'notes must be no more than 500 characters.').optional(),
}).refine((v) => v.method === 'cash' || (v.reference_no && v.reference_no.length >= 2), {
  message: 'reference_no is required for bank_transfer/upi.',
  path: ['reference_no'],
});

export const periodDisputeSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, 'Reason must be at least 3 characters.')
    .max(500, 'Reason must be no more than 500 characters.')
    .optional(),
});

export const periodListSchema = z.object({
  driver_id: z.string().uuid('driver_id must be a UUID.').optional(),
  status: z.enum(['DUE', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'DISPUTED']).optional(),
  week_start: weekStartField.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
