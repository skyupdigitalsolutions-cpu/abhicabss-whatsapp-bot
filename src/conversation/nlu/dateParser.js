const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const customParseFormat = require('dayjs/plugin/customParseFormat');

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const TZ = 'Asia/Kolkata';
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS_FULL = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

function now() {
  return dayjs().tz(TZ);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers for date parsing
// ─────────────────────────────────────────────────────────────────────────────

/** "oct", "october", "sept" -> 9. Anything that isn't a real month name -> -1. */
function monthIndex(word) {
  const w = String(word || '').toLowerCase();
  if (w.length < 3) return -1;
  if (w === 'sept') return 8;
  return MONTHS_FULL.findIndex((m) => m.startsWith(w));
}

/** Builds a valid date in India time, or null (e.g. 31 November, 30 February). */
function makeDate(year, monthIdx, day) {
  if (monthIdx < 0 || monthIdx > 11 || day < 1 || day > 31) return null;
  const mm = String(monthIdx + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  const d = dayjs.tz(`${year}-${mm}-${dd}`, TZ);
  if (!d.isValid() || d.month() !== monthIdx || d.date() !== day) return null;
  return d.startOf('day');
}

/** Next occurrence of (month, day) that is today or later. */
function upcoming(monthIdx, day, today) {
  for (let y = today.year(); y <= today.year() + 4; y += 1) {
    const c = makeDate(y, monthIdx, day);
    if (c && !c.isBefore(today)) return c;
  }
  return null;
}

/** Next occurrence of a bare day-of-month ("27") that is today or later. */
function upcomingDayOfMonth(day, today) {
  for (let k = 0; k < 13; k += 1) {
    const base = today.add(k, 'month');
    const c = makeDate(base.year(), base.month(), day);
    if (c && !c.isBefore(today)) return c;
  }
  return null;
}

/**
 * Cleans customer wording so the parsers below only see simple shapes:
 * "25th of October" -> "25 october", "Sun, 4 Oct" -> "4 oct", "on 1st Nov" -> "1 nov".
 */
function normalizeDateText(raw) {
  let p = String(raw).trim().toLowerCase();
  p = p.replace(/,/g, ' ');
  p = p.replace(/(\d+)\s*(?:st|nd|rd|th)\b/g, '$1'); // 25th -> 25
  p = p.replace(/\b(\d{1,2})\s+of\s+/g, '$1 ');       // 25 of october -> 25 october
  p = p.replace(/^(on|for)\s+/, '');
  if (/\d/.test(p)) {
    // Leading weekday before a date: "sun 4 oct" -> "4 oct"
    p = p.replace(/^(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\s+/, '');
  }
  return p.replace(/\s+/g, ' ').trim();
}

/**
 * Resolves a natural-language date phrase to a concrete date, always
 * anchored to the CURRENT India date/time — never guessed from AI
 * training data, which could be stale. Returns null (never a guess)
 * if the phrase can't be confidently resolved, so the caller can ask
 * the customer to clarify instead of booking the wrong day.
 *
 * Understands: today, tomorrow, day after tomorrow, weekdays, "25 October",
 * "25th October", "October 25th", "25th of Oct", "25/10", "25-10-2026",
 * "2026-10-25" (calendar list replies), bare day numbers ("27"), and list
 * titles such as "Sun, 4 Oct".
 */
function resolveDatePhrase(phrase) {
  if (!phrase) return null;
  const p0 = String(phrase).trim().toLowerCase();
  if (!p0) return null;
  const today = now().startOf('day');

  if (/^(today|tonight)$|आज|ಇಂದು/.test(p0)) return today;
  if (/^(tomorrow|tmrw|tmr)$|कल|ನಾಳೆ|நாளை|రేపు/.test(p0)) return today.add(1, 'day');
  if (/day after tomorrow|परसों/.test(p0)) return today.add(2, 'day');

  const nextWeekdayMatch = p0.match(/next\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/);
  if (nextWeekdayMatch) {
    const targetDow = WEEKDAYS.indexOf(nextWeekdayMatch[1]);
    let diff = targetDow - today.day();
    if (diff <= 0) diff += 7;
    return today.add(diff, 'day');
  }

  const thisWeekdayMatch = p0.match(/^(this\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/);
  if (thisWeekdayMatch) {
    const targetDow = WEEKDAYS.indexOf(thisWeekdayMatch[2]);
    let diff = targetDow - today.day();
    if (diff < 0) diff += 7;
    return today.add(diff, 'day');
  }

  const p = normalizeDateText(phrase);
  let m;

  // "2026-10-25" (value sent back when the customer taps a date in the calendar list)
  if ((m = p.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    return makeDate(+m[1], +m[2] - 1, +m[3]);
  }

  // "25/10", "25-10", "25.10", "25/10/2026", "25-10-26"  (day first)
  if ((m = p.match(/^(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2}|\d{4}))?$/))) {
    const day = +m[1];
    const mon = +m[2] - 1;
    if (m[3]) {
      const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      return makeDate(year, mon, day);
    }
    return upcoming(mon, day, today);
  }

  // "25 october", "25october", "25 oct 2026"
  if ((m = p.match(/^(\d{1,2})\s*([a-z]+)(?:\s+(\d{4}))?$/))) {
    const mon = monthIndex(m[2]);
    if (mon >= 0) return m[3] ? makeDate(+m[3], mon, +m[1]) : upcoming(mon, +m[1], today);
  }

  // "october 25", "oct 25 2026"
  if ((m = p.match(/^([a-z]+)\s*(\d{1,2})(?:\s+(\d{4}))?$/))) {
    const mon = monthIndex(m[1]);
    if (mon >= 0) return m[3] ? makeDate(+m[3], mon, +m[2]) : upcoming(mon, +m[2], today);
  }

  // Bare day of the month: "27" -> the next 27th
  if ((m = p.match(/^(\d{1,2})$/))) {
    return upcomingDayOfMonth(+m[1], today);
  }

  return null;
}

/** Resolves a time phrase like "8am", "20:30", "10 o'clock", "8 in the evening" into {hour, minute}. */
function resolveTimePhrase(phrase) {
  if (!phrase) return null;
  let p = String(phrase).trim().toLowerCase();
  p = p.replace(/\b([ap])\.\s?m\.?/g, '$1m');                       // a.m. -> am
  p = p.replace(/o['’]?\s*clock|\bclock\b|\bhrs?\b|\bat\b/g, ' ');  // o'clock, hrs, at
  p = p.replace(/\s+/g, ' ').trim();

  const valid = (hour, minute) => hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
  let m;

  if ((m = p.match(/(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/))) {
    let hour = parseInt(m[1], 10);
    const minute = m[2] ? parseInt(m[2], 10) : 0;
    if (hour > 12 || minute > 59) return null;
    if (m[3] === 'pm' && hour < 12) hour += 12;
    if (m[3] === 'am' && hour === 12) hour = 0;
    return { hour, minute };
  }

  if ((m = p.match(/^(\d{1,2})[:.](\d{2})$/))) {
    const hour = parseInt(m[1], 10);
    const minute = parseInt(m[2], 10);
    return valid(hour, minute) ? { hour, minute } : null;
  }

  // "8 in the evening", "9 night", "6:30 morning"
  if ((m = p.match(/^(\d{1,2})(?::(\d{2}))?\s*(?:in the\s+)?(morning|afternoon|evening|night)$/))) {
    let hour = parseInt(m[1], 10);
    const minute = m[2] ? parseInt(m[2], 10) : 0;
    if (m[3] === 'afternoon' && hour >= 1 && hour <= 6) hour += 12;
    if (m[3] === 'evening' && hour >= 4 && hour <= 11) hour += 12;
    if (m[3] === 'night' && hour >= 6 && hour <= 11) hour += 12;
    return valid(hour, minute) ? { hour, minute } : null;
  }

  // Bare hour: "10" -> 10:00
  if ((m = p.match(/^(\d{1,2})$/))) {
    const hour = parseInt(m[1], 10);
    return valid(hour, 0) ? { hour, minute: 0 } : null;
  }

  if (/morning/.test(p)) return { hour: 9, minute: 0 };
  if (/afternoon/.test(p)) return { hour: 14, minute: 0 };
  if (/evening/.test(p)) return { hour: 18, minute: 0 };
  if (/night/.test(p)) return { hour: 21, minute: 0 };

  return null;
}

/** Combines a resolved date + time into a single dayjs instant in Asia/Kolkata. */
function combineDateTime(dateDayjs, time) {
  if (!dateDayjs || !time) return null;
  return dateDayjs.hour(time.hour).minute(time.minute).second(0).millisecond(0);
}

function isPast(instant) {
  return instant.isBefore(now());
}

function formatForConfirmation(instant, locale = 'en') {
  // Kept simple/locale-neutral here; locale-specific month/day names are
  // handled in utils/i18n.js when composing the full message.
  return instant.format('dddd, D MMMM YYYY, h:mm A');
}

// ─────────────────────────────────────────────────────────────────────────────
// Calendar: WhatsApp list message with the next 9 days + "Another date"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds the WhatsApp interactive LIST message shown instead of asking the
 * customer to type a date. Dates are computed in India time, so "Today" is
 * correct even while the server (UTC) is still on the previous day.
 * Row ids look like DATE_2026-10-25; "Another date" is DATE_OTHER.
 */
function buildDateListMessage(to, bodyText = 'Select your travel date') {
  const start = now().startOf('day');
  const rows = [];
  for (let i = 0; i < 9; i += 1) {
    const d = start.add(i, 'day');
    rows.push({
      id: `DATE_${d.format('YYYY-MM-DD')}`,
      title: (i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.format('ddd, D MMM')).slice(0, 24),
      description: d.format('D MMMM YYYY').slice(0, 72),
    });
  }
  rows.push({ id: 'DATE_OTHER', title: 'Another date', description: 'Type it, e.g. 25 October' });

  return {
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      action: { button: 'Pick a date', sections: [{ title: 'Travel date', rows }] },
    },
  };
}

/** 'DATE_2026-10-25' -> '2026-10-25'. Anything else (including DATE_OTHER) -> null. */
function parseDateReply(replyId) {
  const m = /^DATE_(\d{4}-\d{2}-\d{2})$/.exec(replyId || '');
  return m ? m[1] : null;
}

module.exports = {
  TZ,
  now,
  resolveDatePhrase,
  resolveTimePhrase,
  combineDateTime,
  isPast,
  formatForConfirmation,
  buildDateListMessage,
  parseDateReply,
};
