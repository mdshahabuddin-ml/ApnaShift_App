// Announcement validation — zod schemas for Super Admin CRUD.
// Times MUST be ISO-8601 with an explicit offset (Z or ±HH:MM); clients
// convert their local wall-clock (IST) before sending. Server stores UTC.
// push_title/push_body optional — dispatcher falls back to title/body.
import { z } from 'zod';

export const ANNOUNCE_SEVERITIES = ['info', 'warning', 'critical', 'maintenance'];
export const ANNOUNCE_AUDIENCES = ['all', 'users', 'drivers'];
export const ANNOUNCE_STATUSES = ['draft', 'published', 'deactivated'];

const isoOffset = z
  .string()
  .datetime({ offset: true })
  .transform((s) => new Date(s));
const isoOffsetNullable = isoOffset.nullable();

const baseFields = {
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(4000),
  severity: z.enum(ANNOUNCE_SEVERITIES),
  audience: z.enum(ANNOUNCE_AUDIENCES),
  start_at: isoOffsetNullable.optional(),
  end_at: isoOffsetNullable.optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  show_banner: z.boolean().optional(),
  maintenance_mode: z.boolean().optional(),
  block_message: z.string().trim().min(1).max(500).nullable().optional(),
  push_enabled: z.boolean().optional(),
  push_title: z.string().trim().min(1).max(200).nullable().optional(),
  push_body: z.string().trim().min(1).max(500).nullable().optional(),
  push_scheduled_at: isoOffsetNullable.optional(),
  // Advance notification: minutes before start_at to auto-schedule the push
  // (jab explicit push_scheduled_at na ho). 0 = start_at par hi.
  notify_before_minutes: z.number().int().min(0).max(10080).nullable().optional(),
  status: z.enum(ANNOUNCE_STATUSES).optional(),
};

function refineWindow(v, ctx) {
  if (v.start_at && v.end_at && v.end_at.getTime() <= v.start_at.getTime()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['end_at'],
      message: 'end_at must be after start_at',
    });
  }
}

export const announcementCreateSchema = z
  .object(baseFields)
  .superRefine((v, ctx) => {
    refineWindow(v, ctx);
    if (v.maintenance_mode && !v.block_message) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['block_message'],
        message: 'block_message is required for maintenance_mode',
      });
    }
  });

// PATCH = partial update: EVERY base field optional (only provided keys
// change); cross-field checks against merged state run in the route.
const updateFields = Object.fromEntries(
  Object.entries(baseFields).map(([k, s]) => [k, s.optional()]),
);

export const announcementUpdateSchema = z
  .object({ ...updateFields, retry_push: z.boolean().optional() })
  .superRefine((v, ctx) => refineWindow(v, ctx));

