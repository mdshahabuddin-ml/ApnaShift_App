// Pricing v2 tests (no DB needed): base/minimum fares + size tiers +
// weight slabs + bulky + item-count + minimum-fare floor.
// Formula: raw = base + distance*rate + size + weight + (bulky?100:0)
//   + max(0,count-5)*20 + helper ; total = round10(MAX(minimum, raw)).
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { computeQuote, buildEstimate } from '../src/services/pricing.js';

const BASE = {
  pickup: { baseRs: 250, perKmRs: 17.5, helperRs: 200, minimumFare: 250 },
  mini_truck: { baseRs: 450, perKmRs: 22.5, helperRs: 200, minimumFare: 450 },
  mini_tractor: { baseRs: 750, perKmRs: 30, helperRs: 200, minimumFare: 750 },
};

describe('pricing v2 - new base/minimum fares', () => {
  it('pickup 10km: 250 + 175 = 425 -> 430', () => {
    expect(computeQuote({ distanceKm: 10, ...BASE.pickup, helperNeeded: false }).total).toBe(430);
  });
  it('mini_truck 10km: 450 + 225 = 675 -> 680', () => {
    expect(computeQuote({ distanceKm: 10, ...BASE.mini_truck, helperNeeded: false }).total).toBe(
      680,
    );
  });
  it('mini_tractor 10km: 750 + 300 = 1050', () => {
    expect(
      computeQuote({ distanceKm: 10, ...BASE.mini_tractor, helperNeeded: false }).total,
    ).toBe(1050);
  });
  it('per_km unchanged: pickup 17.5 / truck 22.5 / tractor 30', () => {
    expect(computeQuote({ distanceKm: 1, ...BASE.pickup, helperNeeded: false }).distance_fare).toBe(
      17.5,
    );
    expect(
      computeQuote({ distanceKm: 1, ...BASE.mini_truck, helperNeeded: false }).distance_fare,
    ).toBe(22.5);
    expect(
      computeQuote({ distanceKm: 1, ...BASE.mini_tractor, helperNeeded: false }).distance_fare,
    ).toBe(30);
  });
});

describe('pricing v2 - minimum fare floor', () => {
  it('raw below minimum -> minimum wins (0 km pickup -> 250)', () => {
    const q = computeQuote({ distanceKm: 0, ...BASE.pickup, helperNeeded: false });
    expect(q.minimum_fare).toBe(250);
    expect(q.total).toBe(250);
  });
  it('high minimum overrides raw (minimum 1000 > raw 430 -> 1000)', () => {
    const q = computeQuote({
      distanceKm: 10, ...BASE.pickup, minimumFare: 1000, helperNeeded: false,
    });
    expect(q.total).toBe(1000);
  });
});

describe('pricing v2 - vehicle size tiers', () => {
  it('chhota adds size_small_extra', () => {
    const q = computeQuote({
      distanceKm: 10, ...BASE.pickup, helperNeeded: false,
      size_small_extra: 50, size_big_extra: 120, vehicleSizeTier: 'chhota',
    });
    expect(q.size_charge).toBe(50);
    expect(q.total).toBe(480); // 425 + 50 = 475 -> 480
  });
  it('bada adds size_big_extra', () => {
    const q = computeQuote({
      distanceKm: 10, ...BASE.pickup, helperNeeded: false,
      size_small_extra: 50, size_big_extra: 120, vehicleSizeTier: 'bada',
    });
    expect(q.size_charge).toBe(120);
    expect(q.total).toBe(550); // 425 + 120 = 545 -> 550
  });
});

describe('pricing v2 - weight slabs', () => {
  const slabs = {
    weight_0_100: 10, weight_100_300: 40, weight_300_500: 80, weight_500_plus: 150,
  };
  it('0-100 kg slab', () => {
    const q = computeQuote({
      distanceKm: 10, ...BASE.pickup, helperNeeded: false, ...slabs, goodsWeightKg: 50,
    });
    expect(q.weight_charge).toBe(10);
  });
  it('100-300 kg slab (101 kg)', () => {
    const q = computeQuote({
      distanceKm: 10, ...BASE.pickup, helperNeeded: false, ...slabs, goodsWeightKg: 101,
    });
    expect(q.weight_charge).toBe(40);
  });
  it('300-500 kg slab (400 kg)', () => {
    const q = computeQuote({
      distanceKm: 10, ...BASE.pickup, helperNeeded: false, ...slabs, goodsWeightKg: 400,
    });
    expect(q.weight_charge).toBe(80);
  });
  it('500+ kg slab (600 kg)', () => {
    const q = computeQuote({
      distanceKm: 10, ...BASE.pickup, helperNeeded: false, ...slabs, goodsWeightKg: 600,
    });
    expect(q.weight_charge).toBe(150);
  });
  it('boundary: exactly 100 -> slab 0-100, 300 -> 100-300, 500 -> 300-500', () => {
    const mk = (w) =>
      computeQuote({ distanceKm: 10, ...BASE.pickup, helperNeeded: false, ...slabs, goodsWeightKg: w })
        .weight_charge;
    expect(mk(100)).toBe(10);
    expect(mk(300)).toBe(40);
    expect(mk(500)).toBe(80);
  });
});

describe('pricing v2 - bulky + item count', () => {
  it('bulky adds Rs 100', () => {
    const q = computeQuote({
      distanceKm: 10, ...BASE.pickup, helperNeeded: false, hasBulkyItem: true,
    });
    expect(q.bulky_charge).toBe(100);
    expect(q.total).toBe(530); // 425 + 100 = 525 -> 530
  });
  it('5 items free, 6th onwards Rs 20 each', () => {
    const mk = (n) =>
      computeQuote({ distanceKm: 10, ...BASE.pickup, helperNeeded: false, itemCount: n });
    expect(mk(5).items_charge).toBe(0);
    expect(mk(6).items_charge).toBe(20);
    expect(mk(8).items_charge).toBe(60);
  });
  it('combined: base + distance + size + weight + bulky + items + helper', () => {
    const q = computeQuote({
      distanceKm: 10, ...BASE.mini_truck, helperNeeded: true,
      size_small_extra: 0, size_big_extra: 150, vehicleSizeTier: 'bada',
      weight_0_100: 0, weight_100_300: 60, weight_300_500: 0, weight_500_plus: 0,
      goodsWeightKg: 200, itemCount: 7, hasBulkyItem: true,
    });
    // 450 + 225 + 150 + 60 + 100 + 40 + 200 = 1225 -> 1230
    expect(q.size_charge).toBe(150);
    expect(q.weight_charge).toBe(60);
    expect(q.bulky_charge).toBe(100);
    expect(q.items_charge).toBe(40);
    expect(q.helper_charge).toBe(200);
    expect(q.total).toBe(1230);
  });
});

describe('pricing v2 - buildEstimate passthrough', () => {
  it('new fields flow into quote', async () => {
    const out = await buildEstimate({
      pickup: { lat: 0, lng: 0 },
      drop: { lat: 0, lng: 1 },
      vehicleType: 'pickup',
      helperNeeded: false,
      vehicleSizeTier: 'bada',
      goodsWeightKg: 200,
      itemCount: 7,
      hasBulkyItem: true,
      rates: {
        pickup: {
          ...BASE.pickup, sizeSmallExtra: 0, sizeBigExtra: 150,
          weight0100: 0, weight100300: 60, weight300500: 0, weight500plus: 0,
        },
      },
      measure: async () => 10,
    });
    expect(out.size_charge).toBe(150);
    expect(out.weight_charge).toBe(60);
    expect(out.bulky_charge).toBe(100);
    expect(out.items_charge).toBe(40);
  });
});

describe('pricing v2 - estimate API accepts new fields (validation)', () => {
  it('bad size tier -> 400', async () => {
    const res = await request(app).post('/api/bookings/estimate-price').send({
      pickup: { lat: 22.72, lng: 75.86 },
      drop: { lat: 22.75, lng: 75.9 },
      vehicle_type: 'pickup',
      vehicle_size_tier: 'xxl',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
  });
  it('negative weight -> 400', async () => {
    const res = await request(app).post('/api/bookings/estimate-price').send({
      pickup: { lat: 22.72, lng: 75.86 },
      drop: { lat: 22.75, lng: 75.9 },
      vehicle_type: 'pickup',
      goods_weight_kg: -5,
    });
    expect(res.status).toBe(400);
  });
  it('item_count 0 -> 400', async () => {
    const res = await request(app).post('/api/bookings/estimate-price').send({
      pickup: { lat: 22.72, lng: 75.86 },
      drop: { lat: 22.75, lng: 75.9 },
      vehicle_type: 'pickup',
      item_count: 0,
    });
    expect(res.status).toBe(400);
  });
});
