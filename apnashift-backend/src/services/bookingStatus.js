// Booking status machine — EK jagah. Transition rules sirf yahan badlo.
// pending -> accepted -> arrived -> in_transit -> delivered, + cancelled.
// Galat transition par 409 invalid_transition (route me assertTransition use karo).
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

// Driver app se sirf aage badh sakta hai (cancel user ka kaam hai).
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
