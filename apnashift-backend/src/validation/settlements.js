// Zod schemas for COD confirm + weekly settlement periods.
// Amounts arrive as rupees numbers (existing API convention); backend
// converts to integer paise immediately (services/money.js).
import { z } from 'zod';
import { parseBody as parseAuthBody, parseQuery } from './payments.js';

export { parseAuthBody as parseBody, parseQuery };

// YYYY-MM-DD Monday (service re-checks Monday-ness -> 400 invalid_week).
const weekStartField = z
  .string({ required_error: 'week_start likho (YYYY-MM-DD, Monday).' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'week_start YYYY-MM-DD me ho.' });

const amountRs = z
  .number({ invalid_type_error: 'amount number ho.' })
  .positive('amount 0 se zyada ho.')
  .max(10000000, 'amount bahut zyada hai.');

export const periodGenerateSchema = z.object({
  driver_id: z.string().uuid('driver_id UUID ho.').optional(),
  week_start: weekStartField.optional(),
});

export const periodPaySchema = z.object({
  amount_rs: amountRs,
  method: z.enum(['cash', 'bank_transfer', 'upi'], {
    errorMap: () => ({ message: 'method cash, bank_transfer ya upi ho.' }),
  }),
  reference_no: z
    .string()
    .trim()
    .min(2, 'reference_no kam se kam 2 akshar.')
    .max(100, 'reference_no 100 akshar se zyada nahi.')
    .optional(),
  notes: z.string().trim().max(500, 'notes 500 akshar se zyada nahi.').optional(),
}).refine((v) => v.method === 'cash' || (v.reference_no && v.reference_no.length >= 2), {
  message: 'bank_transfer/upi par reference_no zaroori hai.',
  path: ['reference_no'],
});

export const periodDisputeSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, 'Wajah kam se kam 3 akshar.')
    .max(500, 'Wajah 500 akshar se zyada nahi.')
    .optional(),
});

export const periodListSchema = z.object({
  driver_id: z.string().uuid('driver_id UUID ho.').optional(),
  status: z.enum(['DUE', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'DISPUTED']).optional(),
  week_start: weekStartField.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
