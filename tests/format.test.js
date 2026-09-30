const { fmtDate, fmtTime, fmtDateTime, fmtShortDate, inr } = require('../src/utils/format');

describe('customer-facing formatting is always India time', () => {
  // 25 Oct 2026 10:00 AM in India = 04:30 UTC
  const tenAmIst = new Date('2026-10-25T04:30:00Z');
  // 25 Oct 2026 1:00 AM in India = 24 Oct 19:30 UTC (the day before, on a UTC server)
  const oneAmIst = new Date('2026-10-24T19:30:00Z');

  test('10:00 AM India time', () => {
    expect(fmtDate(tenAmIst)).toBe('25 Oct 2026');
    expect(fmtTime(tenAmIst)).toBe('10:00 AM');
    expect(fmtDateTime(tenAmIst)).toBe('25 Oct 2026, 10:00 AM');
  });

  test('an early-morning pickup keeps its India date', () => {
    expect(fmtDate(oneAmIst)).toBe('25 Oct 2026');
    expect(fmtShortDate(oneAmIst)).toBe('25 Oct');
    expect(fmtTime(oneAmIst)).toBe('1:00 AM');
  });

  test('rupee amounts use Indian grouping', () => {
    expect(inr(1890)).toBe('₹1,890');
    expect(inr(100000)).toBe('₹1,00,000');
    expect(inr(0)).toBe('₹0');
  });
});
