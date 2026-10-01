const dateParser = require('../src/conversation/nlu/dateParser');

describe('calendar list', () => {
  const rows = dateParser.getDateListRows();

  test('10 rows within WhatsApp limits', () => {
    expect(rows).toHaveLength(10);
    expect(rows.every((r) => r.title.length <= 24 && r.description.length <= 72)).toBe(true);
    expect(new Set(rows.map((r) => r.id)).size).toBe(10);
    expect(rows[9].id).toBe('DATE_OTHER');
  });

  test('first row is today and second is tomorrow, in India time', () => {
    const today = dateParser.now().startOf('day');
    expect(rows[0].title).toBe('Today');
    expect(rows[0].id).toBe(`DATE_${today.format('YYYY-MM-DD')}`);
    expect(rows[1].title).toBe('Tomorrow');
    expect(rows[1].id).toBe(`DATE_${today.add(1, 'day').format('YYYY-MM-DD')}`);
  });

  test('a tapped row resolves back to the same day', () => {
    for (const r of rows.slice(0, 9)) {
      const iso = dateParser.parseDateReply(r.id);
      expect(iso).toBe(r.id.replace('DATE_', ''));
      expect(dateParser.resolveDatePhrase(iso).format('YYYY-MM-DD')).toBe(iso);
    }
    expect(dateParser.parseDateReply('DATE_OTHER')).toBeNull();
  });

  test('the return-date list can start from the pickup day', () => {
    const start = dateParser.now().startOf('day').add(5, 'day');
    const list = dateParser.getDateListRows({ from: start.toDate() });
    expect(list[0].id).toBe(`DATE_${start.format('YYYY-MM-DD')}`);
    expect(list[0].title).not.toBe('Today');
  });
});

describe('typed dates customers actually send', () => {
  const md = (text) => {
    const d = dateParser.resolveDatePhrase(text);
    return d ? [d.month() + 1, d.date()] : null;
  };

  test.each([
    ['25th October', [10, 25]],
    ['25th october', [10, 25]],
    ['25th of October', [10, 25]],
    ['October 25th', [10, 25]],
    ['1st Nov', [11, 1]],
    ['25 Oct', [10, 25]],
    ['25/10', [10, 25]],
    ['Sun, 4 Oct', [10, 4]],
  ])('%s', (text, expected) => {
    expect(md(text)).toEqual(expected);
  });

  test('impossible or unclear dates are rejected, never guessed', () => {
    for (const bad of ['31 nov', '30 feb', '25 foo', 'hello', '32', '0', '']) {
      expect(dateParser.resolveDatePhrase(bad)).toBeNull();
    }
  });

  test('a typed date is never in the past', () => {
    const today = dateParser.now().startOf('day');
    expect(dateParser.resolveDatePhrase('25th October').isBefore(today)).toBe(false);
  });
});

describe('typed times', () => {
  const hm = (text) => {
    const t = dateParser.resolveTimePhrase(text);
    return t ? [t.hour, t.minute] : null;
  };

  test.each([
    ['10', [10, 0]],
    ["10 o'clock", [10, 0]],
    ['8pm', [20, 0]],
    ['8:30 pm', [20, 30]],
    ['20:30', [20, 30]],
    ['8 in the evening', [20, 0]],
    ['3 o clock', [3, 0]],
    ['3 0 clock', [3, 0]], // digit zero typed instead of the letter o
    ['4 0 clock', [4, 0]],
    ['10 clock', [10, 0]],
  ])('%s', (text, expected) => {
    expect(hm(text)).toEqual(expected);
  });

  test('"30 clock" is still rejected (not 3 o\'clock)', () => {
    expect(dateParser.resolveTimePhrase('30 clock')).toBeNull();
  });

  test('impossible times are rejected', () => {
    for (const bad of ['25', '7:75', '13pm', 'abc']) {
      expect(dateParser.resolveTimePhrase(bad)).toBeNull();
    }
  });
});

describe('a tapped calendar row that arrives as two lines', () => {
  test('uses the first line (title) when the description comes with it', () => {
    const rows = dateParser.getDateListRows();
    const row = rows[3]; // e.g. "Sat, 3 Oct" + "3 October 2026"
    const twoLines = `${row.title}\n${row.description}`;
    expect(dateParser.resolveDatePhrase(twoLines).format('YYYY-MM-DD')).toBe(row.id.replace('DATE_', ''));
  });

  test('"Today" with its description resolves to today', () => {
    const today = dateParser.now().startOf('day');
    expect(dateParser.resolveDatePhrase('Today\n1 October 2026').isSame(today, 'day')).toBe(true);
  });
});
