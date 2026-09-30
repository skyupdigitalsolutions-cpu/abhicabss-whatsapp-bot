const dateParser = require('../src/conversation/nlu/dateParser');

describe('dateParser.resolveDatePhrase', () => {
  test('resolves "today" and "tomorrow" relative to India time', () => {
    const today = dateParser.now().startOf('day');
    expect(dateParser.resolveDatePhrase('today').isSame(today, 'day')).toBe(true);
    expect(dateParser.resolveDatePhrase('tomorrow').isSame(today.add(1, 'day'), 'day')).toBe(true);
  });

  test('resolves "next <weekday>" to a date in the future', () => {
    const resolved = dateParser.resolveDatePhrase('next sunday');
    expect(resolved).not.toBeNull();
    expect(resolved.isAfter(dateParser.now().startOf('day'))).toBe(true);
    expect(resolved.day()).toBe(0); // Sunday
  });

  test('returns null for unresolvable phrases rather than guessing', () => {
    expect(dateParser.resolveDatePhrase('whenever is convenient')).toBeNull();
  });

  test('resolves explicit "D MMM" format', () => {
    const resolved = dateParser.resolveDatePhrase('27 Sep');
    expect(resolved).not.toBeNull();
    expect(resolved.date()).toBe(27);
    expect(resolved.month()).toBe(8); // 0-indexed September
  });
});

describe('dateParser.resolveTimePhrase', () => {
  test('resolves "8am" and "8pm"', () => {
    expect(dateParser.resolveTimePhrase('8am')).toEqual({ hour: 8, minute: 0 });
    expect(dateParser.resolveTimePhrase('8pm')).toEqual({ hour: 20, minute: 0 });
  });

  test('resolves "20:30"', () => {
    expect(dateParser.resolveTimePhrase('20:30')).toEqual({ hour: 20, minute: 30 });
  });

  test('resolves vague times to sensible defaults', () => {
    expect(dateParser.resolveTimePhrase('morning')).toEqual({ hour: 9, minute: 0 });
    expect(dateParser.resolveTimePhrase('evening')).toEqual({ hour: 18, minute: 0 });
  });

  test('returns null for unresolvable phrases', () => {
    expect(dateParser.resolveTimePhrase('whenever')).toBeNull();
  });
});
