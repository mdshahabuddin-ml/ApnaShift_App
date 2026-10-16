// Unit tests for price calculation (no DB needed).
// Seed rates (023): Pickup 250+17.5/km/min 250, Mini Truck 450+22.5/km/min 450,
// Mini Tractor 750+30/km/min 750, helper 200.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { computeQuote, buildEstimate } from '../src/services/pricing.js';
import { haversineKm } from '../src/services/distance.js';

const RATES = {
  pickup: { baseRs: 250, perKmRs: 17.5, helperRs: 200, minimumFare: 250 },
  mini_truck: { baseRs: 450, perKmRs: 22.5, helperRs: 200, minimumFare: 450 },
  mini_tractor: { baseRs: 750, perKmRs: 30, helperRs: 200, minimumFare: 750 },
};

describe('computeQuote - 3 gaadi, bina helper (10 km)', () => {
  it('pickup: 250 + 175 = 425 -> 430', () => {
    expect(computeQuote({ distanceKm: 10, ...RATES.pickup, helperNeeded: false })).toMatchObject({
      distance_km: 10,
      base_fare: 250,
      distance_fare: 175,
      helper_charge: 0,
      total: 430,
      estimate_min: 390,
      estimate_max: 470,
    });
  });
  it('mini_truck: 450 + 225 = 675 -> 680', () => {
    expect(
      computeQuote({ distanceKm: 10, ...RATES.mini_truck, helperNeeded: false }).total,
    ).toBe(680);
  });
  it('mini_tractor: 750 + 300 = 1050', () => {
    expect(
      computeQuote({ distanceKm: 10, ...RATES.mini_tractor, helperNeeded: false }).total,
    ).toBe(1050);
  });
});

describe('computeQuote - helper ke saath (10 km)', () => {
  it('pickup + helper: 625 -> 630', () => {
    expect(computeQuote({ distanceKm: 10, ...RATES.pickup, helperNeeded: true })).toMatchObject({
      helper_charge: 200,
      total: 630,
    });
  });
  it('mini_truck + helper: 875 -> 880', () => {
    expect(
      computeQuote({ distanceKm: 10, ...RATES.mini_truck, helperNeeded: true }).total,
    ).toBe(880);
  });
  it('mini_tractor + helper: 1250', () => {
    expect(
      computeQuote({ distanceKm: 10, ...RATES.mini_tractor, helperNeeded: true }).total,
    ).toBe(1250);
  });
});

describe('computeQuote - edge cases', () => {
  it('distance 0: minimum fare lagta hai (pickup -> 250)', () => {
    expect(computeQuote({ distanceKm: 0, ...RATES.pickup, helperNeeded: false })).toMatchObject({
      distance_km: 0,
      distance_fare: 0,
      minimum_fare: 250,
      total: 250,
      estimate_min: 230,
      estimate_max: 280,
    });
  });
  it('bahut lambi distance (500 km pickup): 250 + 8750 = 9000', () => {
    expect(computeQuote({ distanceKm: 500, ...RATES.pickup, helperNeeded: false }).total).toBe(
      9000,
    );
  });
  it('bahut lambi distance (500 km tractor + helper): 750 + 15000 + 200 = 15950', () => {
    expect(
      computeQuote({ distanceKm: 500, ...RATES.mini_tractor, helperNeeded: true }).total,
    ).toBe(15950);
  });
  it('nearest-10 rounding: 424 -> 420, 425 -> 430', () => {
    // 250 + 17.5 x 9.94 = 423.95 -> 420 ; 250 + 17.5 x 10 = 425 -> 430
    expect(computeQuote({ distanceKm: 9.94, ...RATES.pickup, helperNeeded: false }).total).toBe(
      420,
    );
    expect(computeQuote({ distanceKm: 10, ...RATES.pickup, helperNeeded: false }).total).toBe(430);
  });
});

describe('haversine provider', () => {
  it('same point -> 0 km', () => {
    expect(haversineKm({ lat: 22.72, lng: 75.86 }, { lat: 22.72, lng: 75.86 })).toBe(0);
  });
  it('(0,0)-(0,1): ~111 km seedhi x 1.3 = ~144.5 km', () => {
    expect(haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo(144.55, 0);
  });
});

describe('buildEstimate - mock distance provider', () => {
  it('provider mock (10 km) se poora response banta hai', async () => {
    const measure = async () => 10; // mock in place of the real provider
    const out = await buildEstimate({
      pickup: { lat: 22.72, lng: 75.86 },
      drop: { lat: 22.75, lng: 75.9 },
      vehicleType: 'pickup',
      helperNeeded: true,
      rates: { pickup: RATES.pickup },
      measure,
    });
    expect(out).toMatchObject({
      vehicle_type: 'pickup',
      distance_km: 10,
      base_fare: 250,
      distance_fare: 175,
      helper_charge: 200,
      total: 630,
    });
  });
  it('anjaan vehicle_type par 400 error', async () => {
    await expect(
      buildEstimate({
        pickup: { lat: 0, lng: 0 },
        drop: { lat: 1, lng: 1 },
        vehicleType: 'truck',
        helperNeeded: false,
        rates: {},
        measure: async () => 5,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('500 km allowed, 500 se zyada par 400 distance_too_far', async () => {
    const ok = await buildEstimate({
      pickup: { lat: 0, lng: 0 },
      drop: { lat: 0, lng: 1 },
      vehicleType: 'pickup',
      helperNeeded: false,
      rates: { pickup: RATES.pickup },
      measure: async () => 500,
    });
    expect(ok.distance_km).toBe(500);
    await expect(
      buildEstimate({
        pickup: { lat: 0, lng: 0 },
        drop: { lat: 0, lng: 5 },
        vehicleType: 'pickup',
        helperNeeded: false,
        rates: { pickup: RATES.pickup },
        measure: async () => 500.01,
      }),
    ).rejects.toMatchObject({ status: 400, message: 'distance_too_far' });
  });
  it('600 km par 400 distance_too_far (DB insert tak nahi pahunchta)', async () => {
    await expect(
      buildEstimate({
        pickup: { lat: 0, lng: 0 },
        drop: { lat: 0, lng: 5 },
        vehicleType: 'mini_truck',
        helperNeeded: false,
        rates: { mini_truck: RATES.mini_truck },
        measure: async () => 600,
      }),
    ).rejects.toMatchObject({ status: 400, message: 'distance_too_far' });
  });
});

describe('POST /api/bookings/estimate-price - validation (DB se pehle)', () => {
  it('lat 200 par 400', async () => {
    const res = await request(app).post('/api/bookings/estimate-price').send({
      pickup: { lat: 200, lng: 75.86 },
      drop: { lat: 22.75, lng: 75.9 },
      vehicle_type: 'pickup',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
  });
  it('galat vehicle_type par 400', async () => {
    const res = await request(app).post('/api/bookings/estimate-price').send({
      pickup: { lat: 22.72, lng: 75.86 },
      drop: { lat: 22.75, lng: 75.9 },
      vehicle_type: 'truck',
    });
    expect(res.status).toBe(400);
  });
  it('drop missing par 400', async () => {
    const res = await request(app).post('/api/bookings/estimate-price').send({
      pickup: { lat: 22.72, lng: 75.86 },
      vehicle_type: 'pickup',
    });
    expect(res.status).toBe(400);
  });
  it('toota JSON body par 400 invalid_json (parser message nahi)', async () => {
    const res = await request(app)
      .post('/api/bookings/estimate-price')
      .set('Content-Type', 'application/json')
      .send('{{{toota');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'invalid_json' });
  });
});

describe('galat UUID param - 404, 500 nahi (DB se pehle)', () => {
  it('GET /api/drivers/not-a-uuid/ratings -> 404', async () => {
    const res = await request(app).get('/api/drivers/not-a-uuid/ratings');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, error: 'not_found' });
  });
});
