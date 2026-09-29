// Auth ke zod schemas. Phone hamesha normalize hokar niklega
// (parseBody ka return use karo, raw body mat use karo).
import { z } from 'zod';
import { normalizePhone, PHONE_RE } from '../utils/phone.js';

// API boundary: snake_case. DB me display form jata hai (schema CHECK).
export const VEHICLE_TO_DB = {
  pickup: 'Pickup',
  mini_truck: 'Mini Truck',
  mini_tractor: 'Mini Tractor',
};
export const VEHICLE_TO_API = Object.fromEntries(
  Object.entries(VEHICLE_TO_DB).map(([api, db]) => [db, api]),
);

const phoneField = z
  .string({ required_error: 'Phone likho.' })
  .transform((v) => normalizePhone(v))
  .refine((v) => PHONE_RE.test(v), {
    message: 'Phone 10 digit ka Indian mobile hona chahiye (6-9 se shuru).',
  });

const nameField = z
  .string({ required_error: 'Naam likho.' })
  .trim()
  .min(2, 'Naam kam se kam 2 akshar.')
  .max(80, 'Naam 80 akshar se zyada nahi.');

const passwordField = z
  .string({ required_error: 'Password likho.' })
  .min(8, 'Password kam se kam 8 akshar.')
  .max(128, 'Password 128 akshar se zyada nahi.');

export const registerSchema = z.object({
  name: nameField,
  phone: phoneField,
  password: passwordField,
});

export const loginSchema = z.object({
  phone: phoneField,
  password: z.string({ required_error: 'Password likho.' }).min(1, 'Password likho.'),
});

export const driverRegisterSchema = z.object({
  name: nameField,
  phone: phoneField,
  password: passwordField,
  vehicle_type: z.enum(['pickup', 'mini_truck', 'mini_tractor'], {
    errorMap: () => ({ message: 'vehicle_type pickup, mini_truck ya mini_tractor ho.' }),
  }),
  vehicle_number: z
    .string({ required_error: 'Gaadi number likho.' })
    .trim()
    .min(4, 'Gaadi number kam se kam 4 akshar.')
    .max(20, 'Gaadi number 20 akshar se zyada nahi.')
    .transform((v) => v.toUpperCase()),
});

export const adminLoginSchema = loginSchema;

// safeParse wrapper: fail par 400 error (details me sirf field+message, values nahi).
export function parseBody(schema, body) {
  const result = schema.safeParse(body);
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
