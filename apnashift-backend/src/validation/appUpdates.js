// App release validation — zod schemas for Super Admin CRUD.
// version: strict semver x.y.z (pubspec versionName). update_url must be
// https (official Play Store listing / verified APK page only — never a
// raw/unverified APK, never javascript:). Times: ISO-8601 with offset -> UTC.
import { z } from 'zod';
import { cmpSemver } from '../utils/version.js';

export const RELEASE_AUDIENCES = ['all', 'users', 'drivers'];
export const RELEASE_PRIORITIES = ['low', 'normal', 'high'];
export const RELEASE_STATUSES = ['draft', 'published', 'archived'];

const semverStr = z
  .string()
  .trim()
  .max(20)
  .regex(/^\d+\.\d+\.\d+$/, 'version x.y.z format chahiye (e.g. 1.2.0)');

const isoOffset = z
  .string()
  .datetime({ offset: true })
  .transform((s) => new Date(s));
const isoOffsetNullable = isoOffset.nullable();

const httpsUrl = z
  .string()
  .trim()
  .max(500)
  .refine((s) => /^https:\/\/\S+$/i.test(s), 'update_url https:// (official Play Store / APK page) hona chahiye')
  .nullable();

function refineMinMax(v, ctx) {
  if (v.version && v.min_supported_version) {
    const c = cmpSemver(v.min_supported_version, v.version);
    if (!Number.isNaN(c) && c > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['min_supported_version'],
        message: 'min_supported_version version se chhota ya barabar hona chahiye',
      });
    }
  }
}

const baseFields = {
  version: semverStr,
  build: z.number().int().min(1).max(2147483647).nullable().optional(),
  min_supported_version: semverStr.nullable().optional(),
  mandatory: z.boolean().optional(),
  audience: z.enum(RELEASE_AUDIENCES),
  priority: z.enum(RELEASE_PRIORITIES),
  release_notes: z.string().trim().min(1).max(8000),
  update_url: httpsUrl.optional(),
  status: z.enum(RELEASE_STATUSES).optional(),
  push_enabled: z.boolean().optional(),
  push_title: z.string().trim().min(1).max(200).nullable().optional(),
  push_body: z.string().trim().min(1).max(500).nullable().optional(),
  push_scheduled_at: isoOffsetNullable.optional(),
};

export const appReleaseCreateSchema = z
  .object(baseFields)
  .superRefine(refineMinMax);

// PATCH = partial update: every base field optional (only provided keys
// change); merged-state cross-field checks run in the route.
const updateFields = Object.fromEntries(
  Object.entries(baseFields).map(([k, s]) => [k, s.optional()]),
);

export const appReleaseUpdateSchema = z
  .object({ ...updateFields, retry_push: z.boolean().optional() })
  .superRefine((v, ctx) => {
    if ('version' in v || 'min_supported_version' in v) refineMinMax(v, ctx);
  });
