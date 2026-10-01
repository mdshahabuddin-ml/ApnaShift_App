// Booking status machine — single place. Change transition rules only here.
// pending -> accepted -> arrived -> in_transit -> delivered, + cancelled.
// Invalid transitions throw 409 invalid_transition (use assertTransition in routes).
export const BOOKING_STATUS = [
  'pending',
  'accepted',
  'arrived',
  'in_transit',
  'delivered',
  'cancelled',
];

export const TRANSITIONS = {
  pending: ['accepted', 'cancelled'],
  accepted: ['arrived', 'cancelled'],
  arrived: ['in_transit'],
  in_transit: ['delivered'],
  delivered: [],
  cancelled: [],
};

// Driver app can only move forward (cancellation is a user action).
export const DRIVER_TRANSITIONS = {
  accepted: ['arrived'],
  arrived: ['in_transit'],
  in_transit: ['delivered'],
};

export function canTransition(from, to, map = TRANSITIONS) {
  return (map[from] ?? []).includes(to);
}

export function assertTransition(from, to, map = TRANSITIONS) {
  if (!canTransition(from, to, map)) {
    const err = new Error('invalid_transition');
    err.status = 409;
    throw err;
  }
}
