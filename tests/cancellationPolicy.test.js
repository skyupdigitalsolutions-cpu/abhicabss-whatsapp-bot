const { calculateCancellationFee } = require('../src/utils/cancellationPolicy');

describe('calculateCancellationFee', () => {
  test('no fee when cancelling 24+ hours before pickup', () => {
    const result = calculateCancellationFee({ hoursToPickup: 30, total: 2000 });
    expect(result.fee).toBe(0);
    expect(result.refundAmount).toBe(2000);
  });

  test('10% fee between 6 and 24 hours before pickup', () => {
    const result = calculateCancellationFee({ hoursToPickup: 10, total: 2000 });
    expect(result.fee).toBe(200);
    expect(result.refundAmount).toBe(1800);
  });

  test('25% fee between 1 and 6 hours before pickup', () => {
    const result = calculateCancellationFee({ hoursToPickup: 3, total: 2000 });
    expect(result.fee).toBe(500);
    expect(result.refundAmount).toBe(1500);
  });

  test('50% fee under 1 hour before pickup', () => {
    const result = calculateCancellationFee({ hoursToPickup: 0.5, total: 2000 });
    expect(result.fee).toBe(1000);
    expect(result.refundAmount).toBe(1000);
  });

  test('fee + refund always sum to the original total', () => {
    for (const hours of [0.2, 2, 8, 25, 100]) {
      const { fee, refundAmount } = calculateCancellationFee({ hoursToPickup: hours, total: 3333 });
      expect(fee + refundAmount).toBe(3333);
    }
  });
});
