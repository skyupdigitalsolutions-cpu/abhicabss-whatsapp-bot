const { emojiFor, toNumbered, resolveNumericSelection } = require('../src/conversation/numberedMenu');

describe('emojiFor', () => {
  test('renders emoji digits for 0-9', () => {
    expect(emojiFor(1)).toBe('1️⃣');
    expect(emojiFor(9)).toBe('9️⃣');
  });
  test('falls back to plain text for 10+', () => {
    expect(emojiFor(11)).toBe('11.');
  });
});

describe('toNumbered', () => {
  test('prefixes titles and builds a number -> id map, preserving explicit gaps', () => {
    const { rows, map } = toNumbered([
      { id: 'A', number: 1, label: 'Book a Cab' },
      { id: 'B', number: 2, label: 'Fare Estimate' },
      { id: 'C', number: 8, label: 'Support' }, // gap: 3-7 intentionally skipped
    ]);
    expect(rows[0].title).toBe('1️⃣ Book a Cab');
    expect(rows[2].title).toBe('8️⃣ Support');
    expect(map).toEqual({ 1: 'A', 2: 'B', 8: 'C' });
  });
});

describe('resolveNumericSelection', () => {
  const session = { pendingOptionsMap: { 1: 'MENU_BOOK_CAB', 2: 'MENU_FARE_ESTIMATE' } };

  test('resolves a bare digit to the remembered id', () => {
    expect(resolveNumericSelection(session, { text: '1', interactiveId: null })).toBe('MENU_BOOK_CAB');
  });

  test('tolerates trailing punctuation and whitespace', () => {
    expect(resolveNumericSelection(session, { text: ' 2)', interactiveId: null })).toBe('MENU_FARE_ESTIMATE');
    expect(resolveNumericSelection(session, { text: '2.', interactiveId: null })).toBe('MENU_FARE_ESTIMATE');
  });

  test('returns null for a number not in the map (e.g. the skipped 7)', () => {
    expect(resolveNumericSelection(session, { text: '7', interactiveId: null })).toBeNull();
  });

  test('returns null for non-numeric text, so free-text states are unaffected', () => {
    expect(resolveNumericSelection(session, { text: 'Bangalore Airport', interactiveId: null })).toBeNull();
  });

  test('never overrides an actual button/list tap', () => {
    expect(
      resolveNumericSelection(session, { text: '1', interactiveId: 'SOME_OTHER_TAPPED_ID' })
    ).toBeNull();
  });
});

describe('resolveNumericSelection: a tapped row that arrives as its visible text', () => {
  const session = { pendingOptionsMap: { 1: 'CAT_SEDAN', 2: 'CAT_SUV', 3: 'CAT_PREMIUM', 11: 'CAT_X' } };

  test('"1️⃣ Sedan" resolves to the first option', () => {
    expect(resolveNumericSelection(session, { text: '1️⃣ Sedan', interactiveId: null })).toBe('CAT_SEDAN');
  });

  test('works when only interactiveTitle is set', () => {
    expect(resolveNumericSelection(session, { text: null, interactiveTitle: '3️⃣ Premium', interactiveId: null })).toBe('CAT_PREMIUM');
  });

  test('"11. Name" style (10 and above) resolves', () => {
    expect(resolveNumericSelection(session, { text: '11. Name', interactiveId: null })).toBe('CAT_X');
  });

  test('ordinary text that starts with a number is NOT treated as a menu choice', () => {
    expect(resolveNumericSelection(session, { text: '2 adults and 1 child', interactiveId: null })).toBeNull();
    expect(resolveNumericSelection(session, { text: '10 am', interactiveId: null })).toBeNull();
  });

  test('a real tap (hidden id present) always wins', () => {
    expect(resolveNumericSelection(session, { text: '1️⃣ Sedan', interactiveId: 'CAT_SUV' })).toBeNull();
  });
});
