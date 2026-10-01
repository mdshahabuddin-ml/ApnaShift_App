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
    .transform((v) => v.toUpperCase())
    .refine((v) => /^[A-Z0-9 ]+$/.test(v), {
      message: 'Gaadi number me sirf A-Z, 0-9 aur space chalega.',
    }),
  // --- Driver Partner Registration (009): all optional to keep legacy clients
  // (quick form) working. The new wizard marks them required in the frontend.
  email: z.preprocess(
    emptyToUndef,
    z.string().trim().toLowerCase().max(120, 'Email 120 akshar se zyada nahi.').email('Sahi email likho.').optional(),
  ),
  dob: optDate('dob'),
  gender: z.preprocess(
    emptyToUndef,
    z.enum(['male', 'female', 'other', 'prefer_not_to_say'], {
      errorMap: () => ({ message: 'Gender sahi chuno.' }),
    }).optional(),
  ),
  city: optText(2, 120, 'Sheher 2-120 akshar.'),
  state: optText(2, 80, 'State 2-80 akshar.'),
  address: optText(5, 500, 'Address 5-500 akshar.'),
  vehicle_make: optText(2, 40, 'Make 2-40 akshar.'),
  vehicle_model: optText(2, 40, 'Model 2-40 akshar.'),
  vehicle_year: z.preprocess(
    emptyToUndef,
    z.coerce.number().int('Year poora number ho.').min(1990, 'Year 1990 se purana nahi.').max(2100, 'Year 2100 se aage nahi.').optional(),
  ),
  capacity_kg: z.preprocess(
    emptyToUndef,
    z.coerce.number().int('Capacity poora number (kg) ho.').min(0, 'Capacity 0 se kam nahi.').max(50000, 'Capacity 50000 kg se zyada nahi.').optional(),
  ),
  fuel_type: z.preprocess(
    emptyToUndef,
    z.enum(['diesel', 'petrol', 'cng', 'electric', 'other'], {
      errorMap: () => ({ message: 'Fuel type sahi chuno.' }),
    }).optional(),
  ),
  ownership: z.preprocess(
    emptyToUndef,
    z.enum(['owned', 'financed', 'rented', 'other'], {
      errorMap: () => ({ message: 'Ownership sahi chuno.' }),
    }).optional(),
  ),
  license_number: z.preprocess(
    emptyToUndef,
    z.string().trim().max(25, 'License number 25 akshar se zyada nahi.')
      .transform((v) => v.toUpperCase())
      .refine((v) => /^[A-Z0-9 ]{5,25}$/.test(v), {
        message: 'License number 5-25 akshar (A-Z, 0-9, space).',
      }).optional(),
  ),
  license_type: optText(2, 20, 'License type 2-20 akshar (jaise LMV, HMV).'),
  license_expiry: optDate('future'),
  license_state: optText(2, 80, 'Issuing state 2-80 akshar.'),
  rc_number: optText(2, 30, 'RC number 2-30 akshar.'),
  insurance_expiry: optDate('any'),
  pollution_expiry: optDate('any'),
  permit_number: optText(2, 30, 'Permit number 2-30 akshar.'),
  service_city: optText(2, 120, 'Service city 2-120 akshar.'),
  service_state: optText(2, 80, 'Service state 2-80 akshar.'),
  service_areas: optText(2, 300, 'Service areas 300 akshar tak.'),
  service_radius_km: z.preprocess(
    emptyToUndef,
    z.coerce.number().int('Radius poora number (km) ho.').min(1, 'Radius kam se kam 1 km.').max(200, 'Radius 200 km se zyada nahi.').optional(),
  ),
  emergency_name: optText(2, 80, 'Emergency naam 2-80 akshar.'),
  emergency_relation: optText(2, 40, 'Rishta 2-40 akshar.'),
  emergency_phone: z.preprocess(emptyToUndef, phoneField.optional()),
  // If consent is sent it must be true (false = 400). If omitted,
  // legacy clients keep working — hence not required (backward compat).
  consent: z.preprocess(
    (v) => (v === '' || v === undefined || v === null ? undefined : v),
    z.boolean({ invalid_type_error: 'Consent true/false ho.' })
      .refine((v) => v === true, { message: 'Terms consent zaroori hai.' })
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
    dob: 'Umar 18-100 saal ke beech ho (commercial driving eligibility).',
    future: 'Expiry aaj ke baad ki date ho.',
    any: 'Sahi date likho.',
  };
  return z.preprocess(
    emptyToUndef,
    z.string({ required_error: 'Date likho.' })
      .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Date YYYY-MM-DD me likho.' })
      .refine((s) => {
        const [y, m, d] = s.split('-').map(Number);
        const dt = new Date(Date.UTC(y, m - 1, d));
        return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
      }, { message: 'Sahi calendar date likho.' })
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
