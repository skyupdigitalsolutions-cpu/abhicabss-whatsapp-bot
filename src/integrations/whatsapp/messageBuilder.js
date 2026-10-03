const { sendMessage } = require('./client');
const { rememberMenu, forgetMenu } = require('../../conversation/numberedMenu');

// ── Meta WhatsApp field limits (exceeding ANY of these = silent drop) ──
const LIMIT = {
  TEXT_BODY: 4096,   // text message body
  INT_BODY: 1024,    // interactive body text
  HEADER: 60,        // header text
  FOOTER: 60,        // footer text
  BTN_LABEL: 20,     // reply-button title / list "button" label
  ROW_TITLE: 24,     // list row title
  ROW_DESC: 72,      // list row description
  ROW_ID: 200,       // row / button id
  SECTION_TITLE: 24, // list section title
  MAX_BUTTONS: 3,    // reply buttons per message
  MAX_ROWS: 10,      // total rows across all list sections
};

// Trim to limit, coerce to string, strip nothing else.
const clamp = (v, n) => (v == null ? '' : String(v)).slice(0, n);

/** Plain text message. */
async function sendText(to, body) {
  forgetMenu(to); // a plain message means the customer is no longer answering a menu
  return sendMessage({
    to,
    type: 'text',
    text: { body: clamp(body, LIMIT.TEXT_BODY), preview_url: false },
  });
}

/**
 * Interactive reply buttons — max 3 options, each label <= 20 chars.
 * buttons: [{ id: 'BOOK_CAB', title: 'Book a Cab' }, ...]
 */
async function sendButtons(to, bodyText, buttons, { header, footer } = {}) {
  if (!Array.isArray(buttons) || buttons.length === 0) {
    throw new Error('sendButtons: at least one button required.');
  }
  if (buttons.length > LIMIT.MAX_BUTTONS) {
    throw new Error('WhatsApp buttons support max 3 options; use sendList instead.');
  }
  rememberMenu(to, buttons.map((b) => ({ id: b.id, title: clamp(b.title, LIMIT.BTN_LABEL) })));
  return sendMessage({
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      ...(header ? { header: { type: 'text', text: clamp(header, LIMIT.HEADER) } } : {}),
      body: { text: clamp(bodyText, LIMIT.INT_BODY) },
      ...(footer ? { footer: { text: clamp(footer, LIMIT.FOOTER) } } : {}),
      action: {
        buttons: buttons.map((b) => ({
          type: 'reply',
          reply: { id: clamp(b.id, LIMIT.ROW_ID), title: clamp(b.title, LIMIT.BTN_LABEL) },
        })),
      },
    },
  });
}

/**
 * Interactive list — for menus with >3 options.
 * sections: [{ title: 'Menu', rows: [{ id, title, description }] }]
 */
async function sendList(to, bodyText, buttonLabel, sections, { header, footer } = {}) {
  if (!Array.isArray(sections) || sections.length === 0) {
    throw new Error('sendList: at least one section required.');
  }

  let rowCount = 0;
  const cleanSections = sections.map((s) => {
    const rows = (s.rows || []).map((r) => {
      rowCount += 1;
      const row = {
        id: clamp(r.id, LIMIT.ROW_ID),
        title: clamp(r.title, LIMIT.ROW_TITLE),
      };
      // description is optional — only include if present & non-empty
      const desc = clamp(r.description, LIMIT.ROW_DESC);
      if (desc) row.description = desc;
      if (!row.title) throw new Error('sendList: every row needs a non-empty title.');
      return row;
    });
    if (rows.length === 0) throw new Error('sendList: every section needs at least one row.');
    const section = { rows };
    const title = clamp(s.title, LIMIT.SECTION_TITLE);
    if (title) section.title = title;
    return section;
  });

  if (rowCount > LIMIT.MAX_ROWS) {
    throw new Error(`sendList: ${rowCount} rows exceeds Meta's max of ${LIMIT.MAX_ROWS}.`);
  }

  rememberMenu(to, cleanSections.flatMap((sec) => sec.rows));
  return sendMessage({
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      ...(header ? { header: { type: 'text', text: clamp(header, LIMIT.HEADER) } } : {}),
      body: { text: clamp(bodyText, LIMIT.INT_BODY) },
      ...(footer ? { footer: { text: clamp(footer, LIMIT.FOOTER) } } : {}),
      action: {
        button: clamp(buttonLabel, LIMIT.BTN_LABEL) || 'Select',
        sections: cleanSections,
      },
    },
  });
}

async function sendDocument(to, link, filename, caption) {
  forgetMenu(to);
  return sendMessage({
    to,
    type: 'document',
    document: { link, filename, caption },
  });
}

/**
 * "📍 Send Location" button. Tapping it opens WhatsApp's map with the
 * customer's current location; they can send it, move the pin, or search a place.
 */
async function sendLocationRequest(to, bodyText) {
  forgetMenu(to); // the answer is a location or typed address, not a menu choice
  return sendMessage({
    to,
    type: 'interactive',
    interactive: {
      type: 'location_request_message',
      body: { text: clamp(bodyText, LIMIT.INT_BODY) },
      action: { name: 'send_location' },
    },
  });
}

module.exports = { sendText, sendButtons, sendList, sendDocument, sendLocationRequest };
