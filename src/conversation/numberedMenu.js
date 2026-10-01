const EMOJI_DIGITS = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];

/** "1️⃣" for 1-9, falls back to "10." style for anything larger. */
function emojiFor(number) {
  if (number >= 0 && number <= 9) return EMOJI_DIGITS[number];
  return `${number}.`;
}

/**
 * Turns a list of { id, number, label, description? } into:
 *   - rows/buttons ready for WhatsApp (title prefixed with the emoji digit)
 *   - a { "1": id, "2": id, ... } map remembered on the session, so that if
 *     the customer replies with the bare text "1" instead of tapping, the
 *     state machine can resolve it back to the same id (see
 *     resolveNumericSelection below).
 *
 * `number` is explicit (not auto-incremented) so menus can intentionally
 * skip a digit (e.g. the main menu skips 7️⃣, reserved for a future
 * "Offers" item) while still matching what's shown on screen.
 */
function toNumbered(items) {
  const rows = items.map((item) => ({
    id: item.id,
    title: `${emojiFor(item.number)} ${item.label}`.slice(0, item.maxTitleLength || 60),
    ...(item.description ? { description: item.description } : {}),
  }));
  const map = {};
  items.forEach((item) => {
    map[String(item.number)] = item.id;
  });
  return { rows, map };
}

/**
 * Persists the currently-valid number → id map on the session so a
 * follow-up bare-digit reply can be resolved. Overwrites whatever menu
 * was remembered before, so stale numbers from an earlier prompt can
 * never be misinterpreted once a new numbered menu has been shown.
 */
async function rememberOptions(session, map) {
  session.pendingOptionsMap = map;
  await session.save();
}

/**
 * If the inbound message is a bare number ("1", "2)", " 3 ") and the
 * session currently has a remembered numbered menu, returns the id it
 * maps to. Returns null for anything else — including states that are
 * expecting free text (a name, a reason, a passenger count) rather than
 * a menu choice, since callers only invoke this for states that
 * actually presented a numbered menu.
 */
function resolveNumericSelection(session, message) {
  if (message.interactiveId) return null; // an actual tap always wins
  const raw = (message.text || message.interactiveTitle || '').trim();

  // "1", "2)", "3."  — typed by the customer
  // "1️⃣ Sedan", "10. Bus"  — a tapped row/button that reaches us as its visible title
  // (MSG91 does not always pass the hidden row id, only the text the customer tapped)
  const match = raw.match(/^(\d{1,2})[.)]?$/) || raw.match(/^(\d{1,2})(?:\uFE0F?\u20E3|[.)])\s*\S/);
  if (!match) return null;

  const map = session.pendingOptionsMap || {};
  const id = map[match[1]];
  return id || null;
}


// ─────────────────────────────────────────────────────────────────────────────
// Tap recognition: which list row / button did the customer tap?
//
// MSG91 does not reliably pass the hidden row id back, and the visible text can
// arrive as "1️⃣ Sedan", "Sedan", the description line ("1 option · from ₹945"),
// both lines together, or only inside the raw event. So every menu we send is
// remembered per customer (by messageBuilder), and the reply is matched against
// what was actually offered.
//
// Any plain text message we send afterwards forgets the menu, so free-text answers
// (a name, an address, a passenger count) can never be mistaken for a menu choice.
// ─────────────────────────────────────────────────────────────────────────────
const MENU_TTL_MS = 6 * 60 * 60 * 1000;
const menus = new Map(); // whatsapp number -> { items: [{ id, title, description }], at }

function rememberMenu(to, items) {
  menus.set(String(to), {
    at: Date.now(),
    items: items
      .filter((i) => i && i.id)
      .map((i) => ({ id: String(i.id), title: String(i.title || ''), description: String(i.description || '') })),
  });
}

function forgetMenu(to) {
  menus.delete(String(to));
}

/** Lower-case, no emoji variation marks, leading "1️⃣ " / "2. " numbering removed. */
function cleanChoice(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\uFE0F\u200D]/g, '')
    .replace(/^\s*\d{1,2}(?:\u20E3|[.)])\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueId(matches) {
  const ids = [...new Set(matches.map((m) => m.id))];
  return ids.length === 1 ? ids[0] : null;
}

/**
 * Returns the id of the tapped row/button, or null when it cannot be told.
 * message: { text, interactiveTitle, raw } where raw is the original MSG91 event.
 */
function resolveTap(to, message) {
  const entry = menus.get(String(to));
  if (!entry || Date.now() - entry.at > MENU_TTL_MS) return null;
  const items = entry.items;
  if (!items.length) return null;

  // 1) The hidden id is somewhere in the raw event (only if exactly one offered id appears,
  //    so an echoed copy of the whole menu cannot trigger a wrong pick).
  let rawText = '';
  try {
    rawText = message.raw ? JSON.stringify(message.raw).toLowerCase() : '';
  } catch (e) {
    rawText = '';
  }
  if (rawText) {
    const present = items.filter((i) => rawText.includes(i.id.toLowerCase()));
    const byId = uniqueId(present);
    if (byId) return byId;
  }

  // 2) The visible text of the tap, as a whole and line by line.
  const sources = [message.text, message.interactiveTitle].filter(Boolean).map(String);
  const lines = [];
  for (const s of sources) {
    lines.push(s);
    s.split(/\r?\n/).forEach((l) => lines.push(l));
  }
  const cleaned = [...new Set(lines.map(cleanChoice).filter(Boolean))];

  // exact match on a title or a description
  for (const line of cleaned) {
    const hit = uniqueId(items.filter((i) => cleanChoice(i.title) === line || cleanChoice(i.description) === line));
    if (hit) return hit;
  }

  // the text contains a title (or a title starts with what was typed)
  for (const line of cleaned) {
    const hit = uniqueId(
      items.filter((i) => {
        const title = cleanChoice(i.title);
        return title.length >= 3 && (line.includes(title) || (line.length >= 3 && title.startsWith(line)));
      })
    );
    if (hit) return hit;
  }

  // the text contains a description
  for (const line of cleaned) {
    const hit = uniqueId(items.filter((i) => cleanChoice(i.description).length >= 6 && line.includes(cleanChoice(i.description))));
    if (hit) return hit;
  }

  return null;
}

module.exports = {
  emojiFor,
  toNumbered,
  rememberOptions,
  resolveNumericSelection,
  rememberMenu,
  forgetMenu,
  resolveTap,
};

