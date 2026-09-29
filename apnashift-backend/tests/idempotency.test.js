// Item 4 (unit, DB nahi chahiye): Idempotency-Key parse + request hash.
// HTTP replay/422 ke tests DB wale audit-items.test.js me hain.
import { describe, it, expect } from 'vitest';
import { parseIdempotencyKey, hashBookingRequest } from '../src/services/idempotency.js';

function reqWith(key) {
  return { headers: key === undefined ? {} : { 'idempotency-key': key } };
}

const payload = {
  pickup: { address: '12 MG Road, Indore', lat: 0, lng: 0 },
  drop: { address: '45 AB Road, Indore', lat: 0, lng: 1 },
  vehicle_type: 'mini_truck',
  helper_needed: false,
  item_description: 'samaan',
  scheduled_time: undefined,
};

describe('parseIdempotencyKey', () => {
  it('absent -> null (normal flow)', () => {
    expect(parseIdempotencyKey(reqWith(undefined))).toBeNull();
  });
  it('blank/space -> null (ignore)', () => {
    expect(parseIdempotencyKey(reqWith('   '))).toBeNull();
  });
  it('valid key pass (trim ke saath)', () => {
    expect(parseIdempotencyKey(reqWith('  order-abc_123  '))).toBe('order-abc_123');
  });
  it('64 chars pass, 65 fail', () => {
    expect(parseIdempotencyKey(reqWith('a'.repeat(64)))).toBe('a'.repeat(64));
    expect(() => parseIdempotencyKey(reqWith('a'.repeat(65)))).toThrowError(
      expect.objectContaining({ status: 400, message: 'invalid_idempotency_key' }),
    );
  });
  it('space/$ wala key 400 invalid_idempotency_key', () => {
    expect(() => parseIdempotencyKey(reqWith('bad key!'))).toThrowError(
      expect.objectContaining({ status: 400 }),
    );
    expect(() => parseIdempotencyKey(reqWith('key$123'))).toThrowError(
      expect.objectContaining({ message: 'invalid_idempotency_key' }),
    );
  });
});

describe('hashBookingRequest', () => {
  it('same payload -> same hash', () => {
    expect(hashBookingRequest(payload)).toBe(hashBookingRequest({ ...payload }));
  });
  it('alag payload (address/vehicle/helper) -> alag hash', () => {
    expect(hashBookingRequest(payload)).not.toBe(
      hashBookingRequest({ ...payload, vehicle_type: 'pickup' }),
    );
    expect(hashBookingRequest(payload)).not.toBe(
      hashBookingRequest({ ...payload, helper_needed: true }),
    );
    expect(hashBookingRequest(payload)).not.toBe(
      hashBookingRequest({
        ...payload,
        drop: { address: 'Delhi', lat: 1, lng: 1 },
      }),
    );
  });
  it('undefined vs empty item_description same hash (default normalization)', () => {
    const withUndef = { ...payload, item_description: undefined };
    const withEmpty = { ...payload, item_description: '' };
    expect(hashBookingRequest(withUndef)).toBe(hashBookingRequest(withEmpty));
  });
});
