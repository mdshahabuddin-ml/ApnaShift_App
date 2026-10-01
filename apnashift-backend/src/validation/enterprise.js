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
  .string({ required_error: 'Phone likho.' })
  .transform((v) => normalizePhone(v))
  .refine((v) => PHONE_RE.test(v), {
    message: 'Phone 10 digit ka Indian mobile hona chahiye (6-9 se shuru).',
  });

const emailField = z
  .string({ required_error: 'Work email likho.' })
  .trim()
  .toLowerCase()
  .max(160, 'Email 160 akshar se zyada nahi.')
  .email('Sahi work email likho.');

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
    z.array(z.enum(values, { errorMap: () => ({ message }) })).max(10, '10 se zyada options nahi.').default([]),
  );
}

export const inquiryCreateSchema = z.object({
  full_name: z
    .string({ required_error: 'Full name likho.' })
    .trim()
    .min(2, 'Full name kam se kam 2 akshar.')
    .max(100, 'Full name 100 akshar se zyada nahi.'),
  email: emailField,
  phone: phoneField,
  company_name: z
    .string({ required_error: 'Company name likho.' })
    .trim()
    .min(2, 'Company name kam se kam 2 akshar.')
    .max(160, 'Company name 160 akshar se zyada nahi.'),
  website: z.preprocess(emptyToUndef, z
    .string()
    .trim()
    .max(255, 'Website 255 akshar se zyada nahi.')
    .transform((v) => (/^https?:\/\//i.test(v) ? v : `https://${v}`))
    .refine((v) => /^https?:\/\/[^/\s]+\.[^/\s]+/.test(v), { message: 'Sahi website URL likho.' })
    .optional()),
  designation: optText(2, 100, 'Designation 2-100 akshar.'),
  business_type: z.preprocess(
    emptyToUndef,
    z.enum(BUSINESS_TYPES, { errorMap: () => ({ message: 'Business type sahi chuno.' }) }).optional(),
  ),
  company_size: z.preprocess(
    emptyToUndef,
    z.enum(COMPANY_SIZES, { errorMap: () => ({ message: 'Company size sahi chuno.' }) }).optional(),
  ),
  cities: optText(2, 300, 'Cities 2-300 akshar.'),
  operating_state: optText(2, 80, 'State 2-80 akshar.'),
  locations_count: z.preprocess(
    emptyToUndef,
    z.coerce.number().int('Locations poora number ho.').min(1, 'Locations kam se kam 1.').max(100000, 'Locations 100000 se zyada nahi.').optional(),
  ),
  services_required: strArray(ENTERPRISE_SERVICES, 'Service sahi chuno.'),
  vehicle_types: strArray(ENTERPRISE_VEHICLES, 'Vehicle type sahi chuno.'),
  fleet_size: z.preprocess(
    emptyToUndef,
    z.enum(FLEET_SIZES, { errorMap: () => ({ message: 'Fleet size sahi chuno.' }) }).optional(),
  ),
  monthly_trips: z.preprocess(
    emptyToUndef,
    z.enum(MONTHLY_TRIPS, { errorMap: () => ({ message: 'Monthly trips sahi chuno.' }) }).optional(),
  ),
  start_date: z.preprocess(
    emptyToUndef,
    z.string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Start date YYYY-MM-DD me ho.' })
      .refine((s) => {
        const [y, m, d] = s.split('-').map(Number);
        const dt = new Date(Date.UTC(y, m - 1, d));
        return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
      }, { message: 'Sahi calendar date likho.' })
      .optional(),
  ),
  service_frequency: z.preprocess(
    emptyToUndef,
    z.enum(SERVICE_FREQUENCIES, { errorMap: () => ({ message: 'Frequency sahi chuno.' }) }).optional(),
  ),
  budget_range: z.preprocess(
    emptyToUndef,
    z.enum(BUDGET_RANGES, { errorMap: () => ({ message: 'Budget range sahi chuno.' }) }).optional(),
  ),
  requirements: optText(0, 1000, 'Requirements 1000 akshar tak.'),
  // If sent it must be true (false = 400). Omitted = legacy clients safe.
  consent: z.preprocess(
    (v) => (v === '' || v === undefined || v === null ? undefined : v),
    z.boolean({ invalid_type_error: 'Consent true/false ho.' })
      .refine((v) => v === true, { message: 'Terms consent zaroori hai.' })
      .optional(),
  ),
});

// Empty string allowed for requirements (textarea) — separate helper for min 0.
export const inquiryListQuerySchema = z.object({
  status: z.enum(INQUIRY_STATUSES, {
    errorMap: () => ({ message: 'status sahi inquiry status ho.' }),
  }).optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const inquiryStatusSchema = z.object({
  status: z.enum(INQUIRY_STATUSES, {
    errorMap: () => ({ message: 'status NEW, CONTACTED, IN_DISCUSSION, CONVERTED ya CLOSED ho.' }),
  }),
});
