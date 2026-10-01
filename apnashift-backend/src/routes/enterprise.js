// Enterprise inquiries (B2B lead flow).
// POST is public (rate limited) — separate from booking flow, no login.
// Admin list + status update reuse existing admin auth
// (no new auth system). Every admin action goes to audit_logs.
import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { writeLimiter } from '../middleware/writeLimiter.js';
import { logAuditSafe } from '../services/audit.js';
import { validateIdParam } from '../utils/validate.js';
import {
  parseBody,
  parseQuery,
  inquiryCreateSchema,
  inquiryListQuerySchema,
  inquiryStatusSchema,
} from '../validation/enterprise.js';

export const enterpriseRoutes = Router();

const INQUIRY_COLS = `id, full_name, email, phone, company_name, website, designation,
  business_type, company_size, cities, operating_state, locations_count,
  services_required, vehicle_types, fleet_size, monthly_trips, start_date,
  service_frequency, budget_range, requirements, status, created_at, updated_at`;

function toPublicInquiry(r) {
  return {
    id: r.id,
    full_name: r.full_name,
    email: r.email,
    phone: r.phone,
    company_name: r.company_name,
    website: r.website,
    designation: r.designation,
    business_type: r.business_type,
    company_size: r.company_size,
    cities: r.cities,
    operating_state: r.operating_state,
    locations_count: r.locations_count === null ? null : Number(r.locations_count),
    services_required: r.services_required ?? [],
    vehicle_types: r.vehicle_types ?? [],
    fleet_size: r.fleet_size,
    monthly_trips: r.monthly_trips,
    start_date: r.start_date,
    service_frequency: r.service_frequency,
    budget_range: r.budget_range,
    requirements: r.requirements,
    status: r.status,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// POST /api/enterprise/inquiries (public)
enterpriseRoutes.post('/inquiries', writeLimiter, async (req, res, next) => {
  try {
    const data = parseBody(inquiryCreateSchema, req.body);

    // Duplicate: same email + company in last 30 days (enumeration-safe code).
    const dup = await query(
      `SELECT id FROM enterprise_inquiries
        WHERE email = $1 AND LOWER(company_name) = LOWER($2)
          AND created_at > now() - INTERVAL '30 days'
        LIMIT 1`,
      [data.email, data.company_name],
    );
    if (dup.rowCount > 0) {
      return res.status(409).json({ ok: false, error: 'duplicate_inquiry' });
    }

    const inserted = await query(
      `INSERT INTO enterprise_inquiries (full_name, email, phone, company_name, website, designation,
         business_type, company_size, cities, operating_state, locations_count,
         services_required, vehicle_types, fleet_size, monthly_trips, start_date,
         service_frequency, budget_range, requirements)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING ${INQUIRY_COLS}`,
      [
        data.full_name, data.email, data.phone, data.company_name,
        data.website ?? null, data.designation ?? null,
        data.business_type ?? null, data.company_size ?? null,
        data.cities ?? null, data.operating_state ?? null, data.locations_count ?? null,
        data.services_required, data.vehicle_types,
        data.fleet_size ?? null, data.monthly_trips ?? null, data.start_date ?? null,
        data.service_frequency ?? null, data.budget_range ?? null, data.requirements ?? null,
      ],
    );
    const row = inserted.rows[0];
    res.status(201).json({
      ok: true,
      inquiry: { id: row.id, status: row.status, created_at: row.created_at },
    });
  } catch (err) {
    // DB CHECK failure after Zod pass = edge case.
    if (err.code === '23514') {
      err.status = 400;
      err.message = 'validation_failed';
    }
    next(err);
  }
});

// All routes below are admin-only (POST stays public).
enterpriseRoutes.use(requireAuth, requireRole('admin'));

// GET /api/enterprise/inquiries?status=&search=&page=&limit= (admin)
enterpriseRoutes.get('/inquiries', async (req, res, next) => {
  try {
    const { status, search, page, limit } = parseQuery(inquiryListQuerySchema, req.query);
    const offset = (page - 1) * limit;

    const conds = [];
    const params = [];
    let i = 1;
    if (status) {
      conds.push(`status = $${i++}`);
      params.push(status);
    }
    if (search) {
      // Wildcard escape (same pattern as admin.js bookings city search).
      const escaped = search.replace(/[%_\\]/g, (c) => `\\${c}`);
      conds.push(`(company_name ILIKE $${i} ESCAPE '\\' OR email ILIKE $${i} ESCAPE '\\' OR full_name ILIKE $${i} ESCAPE '\\')`);
      params.push(`%${escaped}%`);
      i += 1;
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';

    const [rows, count] = await Promise.all([
      query(
        `SELECT ${INQUIRY_COLS} FROM enterprise_inquiries
         ${where} ORDER BY created_at DESC LIMIT $${i++} OFFSET $${i++}`,
        [...params, limit, offset],
      ),
      query(`SELECT COUNT(*) AS total FROM enterprise_inquiries ${where}`, params),
    ]);
    res.json({
      ok: true,
      page,
      limit,
      total: Number(count.rows[0].total),
      inquiries: rows.rows.map(toPublicInquiry),
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/enterprise/inquiries/:id/status (admin)
enterpriseRoutes.patch('/inquiries/:id/status', validateIdParam, async (req, res, next) => {
  try {
    const { status } = parseBody(inquiryStatusSchema, req.body);
    const updated = await query(
      `UPDATE enterprise_inquiries SET status = $1, updated_at = now()
       WHERE id = $2 RETURNING ${INQUIRY_COLS}`,
      [status, req.params.id],
    );
    if (updated.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    await logAuditSafe(req.user.id, 'inquiry.status', 'enterprise_inquiry', req.params.id, { status });
    res.json({ ok: true, inquiry: toPublicInquiry(updated.rows[0]) });
  } catch (err) {
    next(err);
  }
});
