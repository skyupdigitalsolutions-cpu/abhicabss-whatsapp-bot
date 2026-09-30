const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const customParseFormat = require('dayjs/plugin/customParseFormat');

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const TZ = 'Asia/Kolkata';
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function now() {
  return dayjs().tz(TZ);
}

/**
 * Resolves a natural-language date phrase to a concrete date, always
 * anchored to the CURRENT India date/time — never guessed from AI
 * training data, which could be stale. Returns null (never a guess)
 * if the phrase can't be confidently resolved, so the caller can ask
 * the customer to clarify instead of booking the wrong day.
 */
function resolveDatePhrase(phrase) {
  if (!phrase) return null;
  const p = phrase.trim().toLowerCase();
  const today = now().startOf('day');

  if (/^today$|आज|ಇಂದು/.test(p)) return today;
  if (/^tomorrow$|कल|ನಾಳೆ|நாளை|రేపు/.test(p)) return today.add(1, 'day');
  if (/day after tomorrow|परसों/.test(p)) return today.add(2, 'day');

  const nextWeekdayMatch = p.match(/next\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/);
  if (nextWeekdayMatch) {
    const targetDow = WEEKDAYS.indexOf(nextWeekdayMatch[1]);
    let diff = targetDow - today.day();
    if (diff <= 0) diff += 7;
    return today.add(diff, 'day');
  }

  const thisWeekdayMatch = p.match(/^(this\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/);
  if (thisWeekdayMatch) {
    const targetDow = WEEKDAYS.indexOf(thisWeekdayMatch[2]);
    let diff = targetDow - today.day();
    if (diff < 0) diff += 7;
    return today.add(diff, 'day');
  }

  // Explicit formats: "27 Sep", "27/09", "27-09-2026", "2026-09-27"
  // Use the ORIGINAL (non-lowercased) phrase here — dayjs's customParseFormat
  // matches month names case-sensitively against its locale data ("Sep", not "sep").
  const originalTrimmed = phrase.trim();
  const explicitFormats = ['D MMM', 'D MMMM', 'D/M', 'D-M', 'D/M/YYYY', 'D-M-YYYY', 'YYYY-MM-DD'];
  for (const fmt of explicitFormats) {
    const parsed = dayjs.tz(originalTrimmed, fmt, TZ);
    if (parsed.isValid()) {
      // If year omitted and the resulting date is in the past, assume next year.
      let candidate = parsed.year(fmt.includes('YYYY') ? parsed.year() : today.year());
      if (candidate.isBefore(today)) candidate = candidate.add(1, 'year');
      return candidate.startOf('day');
    }
  }

  return null;
}

/** Resolves a time phrase like "8am", "20:30", "8 in the evening" into {hour, minute}. */
function resolveTimePhrase(phrase) {
  if (!phrase) return null;
  const p = phrase.trim().toLowerCase();

  const ampm = p.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/);
  if (ampm) {
    let hour = parseInt(ampm[1], 10);
    const minute = ampm[2] ? parseInt(ampm[2], 10) : 0;
    const suffix = ampm[3];
    if (suffix === 'pm' && hour < 12) hour += 12;
    if (suffix === 'am' && hour === 12) hour = 0;
    return { hour, minute };
  }

  const hhmm = p.match(/^(\d{1,2}):(\d{2})$/);
  if (hhmm) return { hour: parseInt(hhmm[1], 10), minute: parseInt(hhmm[2], 10) };

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

module.exports = {
  TZ,
  now,
  resolveDatePhrase,
  resolveTimePhrase,
  combineDateTime,
  isPast,
  formatForConfirmation,
};
