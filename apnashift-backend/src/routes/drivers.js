// Driver register. New drivers start with is_verified=false —
// bookings only after admin verification (enforced in booking APIs).
// Extended profile fields (migration 009) are optional — legacy quick form
// still returns 201 without them (backward compatible).
import { Router } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import { query } from '../db.js';
import { config } from '../config.js';
import { signToken } from '../utils/jwt.js';
import { VEHICLE_TO_DB, VEHICLE_TO_API, driverRegisterSchema, parseBody } from '../validation/auth.js';
import { authLimiter } from '../middleware/authLimiter.js';

export const driverRoutes = Router();

// Map the existing verify convention to application status.
// No new status system — is_verified/is_active/rejection_reason is the source.
export function toApplicationStatus(row) {
  if (row.is_verified) return 'APPROVED';
  if (row.rejection_reason) return 'REJECTED';
  return 'PENDING_REVIEW';
}

// Human-readable application ID: AS-2026-AB12CD (unique, regenerated on retry).
async function newApplicationRef() {
  const year = new Date().getFullYear();
  for (let i = 0; i < 5; i += 1) {
    const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
    const ref = `AS-${year}-${rand}`;
    const found = await query('SELECT 1 FROM drivers WHERE application_ref = $1', [ref]);
    if (found.rowCount === 0) return ref;
  }
  // Very rare collision — id-based fallback (guaranteed unique).
  return `AS-${year}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
}

// POST /api/drivers/register
driverRoutes.post('/register', authLimiter, async (req, res, next) => {
  try {
    const data = parseBody(driverRegisterSchema, req.body);
    const { name, phone, password, vehicle_type, vehicle_number } = data;

    // Cross-table uniqueness: one number only once across users/drivers/admins.
    const existing = await query(
      `SELECT 1 FROM users WHERE phone = $1
       UNION ALL SELECT 1 FROM drivers WHERE phone = $1
       UNION ALL SELECT 1 FROM admins WHERE phone = $1 LIMIT 1`,
      [phone],
    );
    if (existing.rowCount > 0) {
      return res.status(409).json({ ok: false, error: 'phone_taken' });
    }

    // Duplicate identifiers — enumeration-safe generic-ish codes (task spec).
    // Never reveal who owns the email/license/vehicle, only the code.
    if (data.email) {
      const dup = await query('SELECT 1 FROM drivers WHERE email = $1 LIMIT 1', [data.email]);
      if (dup.rowCount > 0) {
        return res.status(409).json({ ok: false, error: 'driver_already_registered' });
      }
    }
    if (data.license_number) {
      const dup = await query('SELECT 1 FROM drivers WHERE license_number = $1 LIMIT 1', [
        data.license_number,
      ]);
      if (dup.rowCount > 0) {
        return res.status(409).json({ ok: false, error: 'license_already_registered' });
      }
    }
    {
      const dup = await query('SELECT 1 FROM drivers WHERE vehicle_number = $1 LIMIT 1', [
        vehicle_number,
      ]);
      if (dup.rowCount > 0) {
        return res.status(409).json({ ok: false, error: 'vehicle_already_registered' });
      }
    }

    const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
    const applicationRef = await newApplicationRef();
    let inserted;
    try {
      inserted = await query(
        `INSERT INTO drivers (name, phone, password_hash, vehicle_type, vehicle_number, is_verified,
           email, dob, gender, city, state, address,
           vehicle_make, vehicle_model, vehicle_year, capacity_kg, fuel_type, ownership,
           license_number, license_type, license_expiry, license_state,
           rc_number, insurance_expiry, pollution_expiry, permit_number,
           service_city, service_state, service_areas, service_radius_km,
           emergency_name, emergency_relation, emergency_phone,
           application_ref, consent_at, upi_id)
         VALUES ($1, $2, $3, $4, $5, FALSE,
           $6, $7, $8, $9, $10, $11,
           $12, $13, $14, $15, $16, $17,
           $18, $19, $20, $21,
           $22, $23, $24, $25,
           $26, $27, $28, $29,
           $30, $31, $32,
           $33, CASE WHEN $34 THEN now() ELSE NULL END, $35)
         RETURNING id, name, phone, vehicle_type, vehicle_number, is_verified,
           email, city, state, application_ref, rejection_reason, upi_id, created_at`,
        [
          name, phone, passwordHash, VEHICLE_TO_DB[vehicle_type], vehicle_number,
          data.email ?? null, data.dob ?? null, data.gender ?? null,
          data.city ?? null, data.state ?? null, data.address ?? null,
          data.vehicle_make ?? null, data.vehicle_model ?? null, data.vehicle_year ?? null,
          data.capacity_kg ?? null, data.fuel_type ?? null, data.ownership ?? null,
          data.license_number ?? null, data.license_type ?? null, data.license_expiry ?? null,
          data.license_state ?? null,
          data.rc_number ?? null, data.insurance_expiry ?? null, data.pollution_expiry ?? null,
          data.permit_number ?? null,
          data.service_city ?? null, data.service_state ?? null, data.service_areas ?? null,
          data.service_radius_km ?? null,
          data.emergency_name ?? null, data.emergency_relation ?? null, data.emergency_phone ?? null,
          applicationRef, data.consent === true, data.upi_id ?? null,
        ],
      );
    } catch (err) {
      if (err.code === '23505') {
        const c = err.constraint ?? '';
        if (c.includes('email')) {
          return res.status(409).json({ ok: false, error: 'driver_already_registered' });
        }
        if (c.includes('license')) {
          return res.status(409).json({ ok: false, error: 'license_already_registered' });
        }
        return res.status(409).json({ ok: false, error: 'phone_taken' });
      }
      // DB CHECK failure after Zod pass = edge case (race/date boundary).
      if (err.code === '23514') {
        err.status = 400;
        err.message = 'validation_failed';
      }
      throw err;
    }

    const row = inserted.rows[0];
    const user = {
      id: row.id,
      name: row.name,
      phone: row.phone,
      role: 'driver',
      vehicle_type: VEHICLE_TO_API[row.vehicle_type] ?? vehicle_type,
      vehicle_number: row.vehicle_number,
      is_verified: row.is_verified,
      email: row.email,
      city: row.city,
      state: row.state,
      application_ref: row.application_ref,
      upi_id: row.upi_id ?? null,
    };
    const token = signToken({ id: user.id, role: 'driver' });
    res.status(201).json({
      ok: true,
      token,
      user,
      application: {
        id: row.application_ref,
        status: toApplicationStatus(row),
        registered_at: row.created_at,
      },
    });
  } catch (err) {
    next(err);
  }
});
