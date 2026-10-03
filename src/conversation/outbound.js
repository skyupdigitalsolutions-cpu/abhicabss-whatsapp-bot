const { sendText, sendButtons, sendList, sendDocument, sendLocationRequest } = require('../integrations/whatsapp/messageBuilder');
const { logger } = require('../config/logger');
const { t } = require('../utils/i18n');

/**
 * Builds a small per-request "sender" bound to one customer + language,
 * so handlers can write `ctx.send.text('booking_created')` instead of
 * repeating the phone number and translation lookup everywhere.
 */
function makeSender(to, language) {
  return {
    raw: (body) => sendText(to, body),
    text: (key, vars) => sendText(to, t(language, key, vars)),
    buttons: (bodyKey, buttons, opts) => sendButtons(to, t(language, bodyKey, opts?.vars), buttons, opts),
    buttonsRaw: (body, buttons, opts) => sendButtons(to, body, buttons, opts),
    list: (bodyKey, buttonLabelKey, sections, opts) =>
      sendList(to, t(language, bodyKey, opts?.vars), t(language, buttonLabelKey), sections, opts),
    listRaw: (body, buttonLabel, sections, opts) => sendList(to, body, buttonLabel, sections, opts),
    document: (link, filename, captionKey) => sendDocument(to, link, filename, captionKey ? t(language, captionKey) : undefined),
    // "📍 Send Location" button. If MSG91/WhatsApp ever rejects it, the same
    // question goes out as plain text so the customer is never left without a prompt.
    locationRequest: async (body) => {
      try {
        return await sendLocationRequest(to, body);
      } catch (err) {
        logger.warn({ err: err.message }, '[outbound] location button failed — sending plain text instead');
        return sendText(to, body);
      }
    },
  };
}

module.exports = { makeSender };
