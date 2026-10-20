// Zod schemas for auth. Phone is always returned normalized
// (use parseBody's return value, not the raw body).
import { z } from 'zod';
import { normalizePhone, PHONE_RE } from '../utils/phone.js';

// API boundary: snake_case. Display form goes to DB (schema CHECK).
export const VEHICLE_TO_DB = {
  pickup: 'Pickup',
  mini_truck: 'Mini Truck',
  mini_tractor: 'Mini Tractor',
};
export const VEHICLE_TO_API = Object.fromEntries(
  Object.entries(VEHICLE_TO_DB).map(([api, db]) => [db, api]),
);

const phoneField = z
  .string({ required_error: 'Enter your phone number.' })
  .transform((v) => normalizePhone(v))
  .refine((v) => PHONE_RE.test(v), {
    message: 'Phone must be a 10-digit Indian mobile number (starting with 6-9).',
  });

const nameField = z
  .string({ required_error: 'Enter your name.' })
  .trim()
  .min(2, 'Name must be at least 2 characters.')
  .max(80, 'Name must be no more than 80 characters.');

const passwordField = z
  .string({ required_error: 'Enter your password.' })
  .min(8, 'Password must be at least 8 characters.')
  .max(128, 'Password must be no more than 128 characters.');

export const registerSchema = z.object({
  name: nameField,
  phone: phoneField,
  password: passwordField,
});

export const loginSchema = z.object({
  phone: phoneField,
  password: z.string({ required_error: 'Enter your password.' }).min(1, 'Enter your password.'),
});

export const driverRegisterSchema = z.object({
  name: nameField,
  phone: phoneField,
  password: passwordField,
  vehicle_type: z.enum(['pickup', 'mini_truck', 'mini_tractor'], {
    errorMap: () => ({ message: 'vehicle_type must be pickup, mini_truck, or mini_tractor.' }),
  }),
  vehicle_number: z
    .string({ required_error: 'Enter the vehicle registration number.' })
    .trim()
    .min(4, 'Vehicle number must be at least 4 characters.')
    .max(20, 'Vehicle number must be no more than 20 characters.')
    .transform((v) => v.toUpperCase())
    .refine((v) => /^[A-Z0-9 ]+$/.test(v), {
      message: 'Vehicle number may only contain A-Z, 0-9, and spaces.',
    }),
  // --- Driver Partner Registration (009): all optional to keep legacy clients
  // (quick form) working. The new wizard marks them required in the frontend.
  email: z.preprocess(
    emptyToUndef,
    z.string().trim().toLowerCase().max(120, 'Email must be no more than 120 characters.').email('Enter a valid email address.').optional(),
  ),
  dob: optDate('dob'),
  gender: z.preprocess(
    emptyToUndef,
    z.enum(['male', 'female', 'other', 'prefer_not_to_say'], {
      errorMap: () => ({ message: 'Select a valid gender.' }),
    }).optional(),
  ),
  city: optText(2, 120, 'City must be 2-120 characters.'),
  state: optText(2, 80, 'State must be 2-80 characters.'),
  address: optText(5, 500, 'Address must be 5-500 characters.'),
  vehicle_make: optText(2, 40, 'Make must be 2-40 characters.'),
  vehicle_model: optText(2, 40, 'Model must be 2-40 characters.'),
  vehicle_year: z.preprocess(
    emptyToUndef,
    z.coerce.number().int('Year must be a whole number.').min(1990, 'Year cannot be earlier than 1990.').max(2100, 'Year cannot be later than 2100.').optional(),
  ),
  capacity_kg: z.preprocess(
    emptyToUndef,
    z.coerce.number().int('Capacity must be a whole number (kg).').min(0, 'Capacity must be at least 0.').max(50000, 'Capacity must be no more than 50000 kg.').optional(),
  ),
  fuel_type: z.preprocess(
    emptyToUndef,
    z.enum(['diesel', 'petrol', 'cng', 'electric', 'other'], {
      errorMap: () => ({ message: 'Select a valid fuel type.' }),
    }).optional(),
  ),
  ownership: z.preprocess(
    emptyToUndef,
    z.enum(['owned', 'financed', 'rented', 'other'], {
      errorMap: () => ({ message: 'Select a valid ownership type.' }),
    }).optional(),
  ),
  license_number: z.preprocess(
    emptyToUndef,
    z.string().trim().max(25, 'License number must be no more than 25 characters.')
      .transform((v) => v.toUpperCase())
      .refine((v) => /^[A-Z0-9 ]{5,25}$/.test(v), {
        message: 'License number must be 5-25 characters (A-Z, 0-9, spaces).',
      }).optional(),
  ),
  license_type: optText(2, 20, 'License type must be 2-20 characters (e.g. LMV, HMV).'),
  license_expiry: optDate('future'),
  license_state: optText(2, 80, 'Issuing state must be 2-80 characters.'),
  rc_number: optText(2, 30, 'RC number must be 2-30 characters.'),
  insurance_expiry: optDate('any'),
  pollution_expiry: optDate('any'),
  permit_number: optText(2, 30, 'Permit number must be 2-30 characters.'),
  service_city: optText(2, 120, 'Service city must be 2-120 characters.'),
  service_state: optText(2, 80, 'Service state must be 2-80 characters.'),
  service_areas: optText(2, 300, 'Service areas must be up to 300 characters.'),
  service_radius_km: z.preprocess(
    emptyToUndef,
    z.coerce.number().int('Radius must be a whole number (km).').min(1, 'Radius must be at least 1 km.').max(200, 'Radius must be no more than 200 km.').optional(),
  ),
  emergency_name: optText(2, 80, 'Emergency contact name must be 2-80 characters.'),
  emergency_relation: optText(2, 40, 'Relationship must be 2-40 characters.'),
  emergency_phone: z.preprocess(emptyToUndef, phoneField.optional()),
  // UPI handle (optional at register; driver/profile se baad me bhi jud sakta hai).
  // Spec regex ^[\w.\-]{2,256}@... — trailing \- lint-safe form me (same language).
  upi_id: z.preprocess(
    emptyToUndef,
    z.string().trim().max(321, 'UPI ID is too long.')
      .regex(/^[\w.-]{2,256}@[a-zA-Z]{2,64}$/, { message: 'UPI ID must be in the format name@bank.' })
      .optional(),
  ),
  // If consent is sent it must be true (false = 400). If omitted,
  // legacy clients keep working — hence not required (backward compat).
  consent: z.preprocess(
    (v) => (v === '' || v === undefined || v === null ? undefined : v),
    z.boolean({ invalid_type_error: 'Consent must be true or false.' })
      .refine((v) => v === true, { message: 'Terms consent is required.' })
      .optional(),
  ),
});

// Map empty strings to undefined so optional fields sent as ""
// do not fail with a "required"-like 400 (forms send empty fields as "").
function emptyToUndef(v) {
  return typeof v === 'string' && v.trim() === '' ? undefined : v;
}

function optText(min, max, message) {
  return z.preprocess(emptyToUndef, z.string().trim().min(min, message).max(max, message).optional());
}

// Date kinds: dob (18-100 years), future (after today), any (calendar check only).
function optDate(kind) {
  const messages = {
    dob: 'Age must be between 18 and 100 years (commercial driving eligibility).',
    future: 'Expiry must be a date after today.',
    any: 'Enter a valid date.',
  };
  return z.preprocess(
    emptyToUndef,
    z.string({ required_error: 'Enter a date.' })
      .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Enter the date in YYYY-MM-DD format.' })
      .refine((s) => {
        const [y, m, d] = s.split('-').map(Number);
        const dt = new Date(Date.UTC(y, m - 1, d));
        return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
      }, { message: 'Enter a valid calendar date.' })
      .refine((s) => checkDateKind(kind, s), { message: messages[kind] })
      .optional(),
  );
}

function checkDateKind(kind, s) {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const now = new Date();
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (kind === 'future') return dt.getTime() > todayUTC.getTime();
  if (kind === 'dob') {
    const min = new Date(todayUTC); min.setUTCFullYear(min.getUTCFullYear() - 100);
    const max = new Date(todayUTC); max.setUTCFullYear(max.getUTCFullYear() - 18);
    return dt.getTime() >= min.getTime() && dt.getTime() <= max.getTime();
  }
  return true;
}

export const adminLoginSchema = loginSchema;

// Self-service password reset (zero-cost OTP).
// forgot: sirf phone — hamesha ok:true (enumeration rokne ke liye).
export const forgotPasswordSchema = z.object({
  phone: phoneField,
});

// reset: phone + 6-digit OTP + naya password (min 8, admin-reset jaisa).
export const resetPasswordSchema = z.object({
  phone: phoneField,
  otp: z
    .string({ required_error: 'Enter the OTP.' })
    .trim()
    .regex(/^\d{6}$/, { message: 'OTP must be a 6-digit number.' }),
  new_password: passwordField,
});

// PATCH /api/driver/profile — driver khud apna UPI ID jod/badalkar sakta hai
// (null bhejne par clear ho jata hai). Sirf upi_id editable hai.
export const driverProfileSchema = z.object({
  upi_id: z
    .string()
    .trim()
    .max(321, 'UPI ID is too long.')
    .regex(/^[\w.-]{2,256}@[a-zA-Z]{2,64}$/, { message: 'UPI ID must be in the format name@bank.' })
    .nullable()
    .optional(),
});

// safeParse wrapper: 400 on failure (details hold only field+message, no values).
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
