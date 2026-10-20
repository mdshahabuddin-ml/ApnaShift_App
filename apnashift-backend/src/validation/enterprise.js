// Zod schemas for enterprise inquiry (B2B lead).
// Conventions: parseBody/parseQuery wrappers (field+message details only),
// empty string -> undefined (forms send ""), snake_case API boundary.
import { z } from 'zod';
import { normalizePhone, PHONE_RE } from '../utils/phone.js';
import { parseBody as parseAuthBody } from './auth.js';
import { parseQuery as parseBookingQuery } from './booking.js';

export { parseAuthBody as parseBody };
export { parseBookingQuery as parseQuery };

function emptyToUndef(v) {
  return typeof v === 'string' && v.trim() === '' ? undefined : v;
}

function optText(min, max, message) {
  return z.preprocess(emptyToUndef, z.string().trim().min(min, message).max(max, message).optional());
}

const phoneField = z
  .string({ required_error: 'Enter your phone number.' })
  .transform((v) => normalizePhone(v))
  .refine((v) => PHONE_RE.test(v), {
    message: 'Phone must be a 10-digit Indian mobile number (starting with 6-9).',
  });

const emailField = z
  .string({ required_error: 'Enter your work email.' })
  .trim()
  .toLowerCase()
  .max(160, 'Email must be no more than 160 characters.')
  .email('Enter a valid work email address.');

export const BUSINESS_TYPES = [
  'ecommerce',
  'retail',
  'manufacturing',
  'construction',
  'hospitality',
  'healthcare',
  'education',
  'corporate',
  'other',
];

export const COMPANY_SIZES = ['1-10', '11-50', '51-200', '201-500', '500+'];

export const ENTERPRISE_SERVICES = [
  'local_delivery',
  'business_transport',
  'goods_transport',
  'fleet_services',
  'employee_transport',
  'scheduled_deliveries',
  'on_demand_delivery',
  'intercity_transport',
  'other',
];

// Inquiry preferences — separate from the bookings/drivers vehicle enum.
export const ENTERPRISE_VEHICLES = [
  'bike',
  'auto',
  'mini_truck',
  'pickup',
  'lcv',
  'truck',
  'other',
];

export const FLEET_SIZES = ['1-5', '6-20', '21-50', '51-100', '100+'];
export const MONTHLY_TRIPS = ['1-100', '101-500', '501-1000', '1000+'];
export const SERVICE_FREQUENCIES = ['daily', 'weekly', 'monthly', 'on_demand'];
export const BUDGET_RANGES = ['under_25k', '25k_50k', '50k_1l', '1l_plus', 'discuss'];
export const INQUIRY_STATUSES = ['NEW', 'CONTACTED', 'IN_DISCUSSION', 'CONVERTED', 'CLOSED'];

function strArray(values, message) {
  return z.preprocess(
    (v) => (v === undefined || v === null ? [] : v),
    z.array(z.enum(values, { errorMap: () => ({ message }) })).max(10, 'No more than 10 options allowed.').default([]),
  );
}

export const inquiryCreateSchema = z.object({
  full_name: z
    .string({ required_error: 'Enter your full name.' })
    .trim()
    .min(2, 'Full name must be at least 2 characters.')
    .max(100, 'Full name must be no more than 100 characters.'),
  email: emailField,
  phone: phoneField,
  company_name: z
    .string({ required_error: 'Enter the company name.' })
    .trim()
    .min(2, 'Company name must be at least 2 characters.')
    .max(160, 'Company name must be no more than 160 characters.'),
  website: z.preprocess(emptyToUndef, z
    .string()
    .trim()
    .max(255, 'Website must be no more than 255 characters.')
    .transform((v) => (/^https?:\/\//i.test(v) ? v : `https://${v}`))
    .refine((v) => /^https?:\/\/[^/\s]+\.[^/\s]+/.test(v), { message: 'Enter a valid website URL.' })
    .optional()),
  designation: optText(2, 100, 'Designation must be 2-100 characters.'),
  business_type: z.preprocess(
    emptyToUndef,
    z.enum(BUSINESS_TYPES, { errorMap: () => ({ message: 'Select a valid business type.' }) }).optional(),
  ),
  company_size: z.preprocess(
    emptyToUndef,
    z.enum(COMPANY_SIZES, { errorMap: () => ({ message: 'Select a valid company size.' }) }).optional(),
  ),
  cities: optText(2, 300, 'Cities must be 2-300 characters.'),
  operating_state: optText(2, 80, 'State must be 2-80 characters.'),
  locations_count: z.preprocess(
    emptyToUndef,
    z.coerce.number().int('Locations must be a whole number.').min(1, 'Locations must be at least 1.').max(100000, 'Locations must be no more than 100000.').optional(),
  ),
  services_required: strArray(ENTERPRISE_SERVICES, 'Select a valid service.'),
  vehicle_types: strArray(ENTERPRISE_VEHICLES, 'Select a valid vehicle type.'),
  fleet_size: z.preprocess(
    emptyToUndef,
    z.enum(FLEET_SIZES, { errorMap: () => ({ message: 'Select a valid fleet size.' }) }).optional(),
  ),
  monthly_trips: z.preprocess(
    emptyToUndef,
    z.enum(MONTHLY_TRIPS, { errorMap: () => ({ message: 'Select a valid monthly trips range.' }) }).optional(),
  ),
  start_date: z.preprocess(
    emptyToUndef,
    z.string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Start date must be in YYYY-MM-DD format.' })
      .refine((s) => {
        const [y, m, d] = s.split('-').map(Number);
        const dt = new Date(Date.UTC(y, m - 1, d));
        return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
      }, { message: 'Enter a valid calendar date.' })
      .optional(),
  ),
  service_frequency: z.preprocess(
    emptyToUndef,
    z.enum(SERVICE_FREQUENCIES, { errorMap: () => ({ message: 'Select a valid frequency.' }) }).optional(),
  ),
  budget_range: z.preprocess(
    emptyToUndef,
    z.enum(BUDGET_RANGES, { errorMap: () => ({ message: 'Select a valid budget range.' }) }).optional(),
  ),
  requirements: optText(0, 1000, 'Requirements must be up to 1000 characters.'),
  // If sent it must be true (false = 400). Omitted = legacy clients safe.
  consent: z.preprocess(
    (v) => (v === '' || v === undefined || v === null ? undefined : v),
    z.boolean({ invalid_type_error: 'Consent must be true or false.' })
      .refine((v) => v === true, { message: 'Terms consent is required.' })
      .optional(),
  ),
});

// Empty string allowed for requirements (textarea) — separate helper for min 0.
export const inquiryListQuerySchema = z.object({
  status: z.enum(INQUIRY_STATUSES, {
    errorMap: () => ({ message: 'status must be a valid inquiry status.' }),
  }).optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const inquiryStatusSchema = z.object({
  status: z.enum(INQUIRY_STATUSES, {
    errorMap: () => ({ message: 'status must be NEW, CONTACTED, IN_DISCUSSION, CONVERTED, or CLOSED.' }),
  }),
});
