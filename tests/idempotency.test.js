const { bookingIdempotencyKey, paymentIdempotencyKey } = require('../src/utils/idempotency');

describe('bookingIdempotencyKey', () => {
  const draft = {
    tripType: 'ONE_WAY',
    pickup: { address: 'Bangalore Airport', latitude: 13.19, longitude: 77.7 },
    drop: { address: 'Mysore', latitude: 12.29, longitude: 76.6 },
    pickupAt: '2026-09-27T02:30:00.000Z',
    returnAt: null,
    rentalHours: null,
    vehicleId: 'premium-innova-crysta',
    fareQuoteId: 'Q-abc123',
  };

  test('same session + same draft always yields the same key', () => {
    const k1 = bookingIdempotencyKey('session-1', draft);
    const k2 = bookingIdempotencyKey('session-1', { ...draft });
    expect(k1).toBe(k2);
  });

  test('a changed draft field yields a different key', () => {
    const k1 = bookingIdempotencyKey('session-1', draft);
    const k2 = bookingIdempotencyKey('session-1', { ...draft, vehicleId: 'suv-ertiga' });
    expect(k1).not.toBe(k2);
  });

  test('different sessions never collide even with identical drafts', () => {
    const k1 = bookingIdempotencyKey('session-1', draft);
    const k2 = bookingIdempotencyKey('session-2', draft);
    expect(k1).not.toBe(k2);
  });
});

describe('paymentIdempotencyKey', () => {
  test('increments with attempt number so retries get a fresh key', () => {
    const k1 = paymentIdempotencyKey('booking-1', 1);
    const k2 = paymentIdempotencyKey('booking-1', 2);
    expect(k1).not.toBe(k2);
  });
});
