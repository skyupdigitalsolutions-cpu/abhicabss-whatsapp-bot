const { logger } = require('../config/logger');
const { normalizeInboundMessage } = require('../conversation/inbound');
const { processInboundMessage } = require('../conversation/stateMachine');
const { getPrisma } = require('../config/db');
const { normalizeWhatsAppNumber } = require('../utils/phone');
const { perCustomerRateOk } = require('../middleware/rateLimiter');

/**
 * POST /webhook/whatsapp — receives MSG91's WhatsApp webhook events.
 *
 * Unlike Meta's direct Cloud API, MSG91 has no GET verification
 * handshake to register a callback URL — you just paste this URL into
 * MSG91's "Webhook (New)" config screen and it starts POSTing here.
 * Each call carries ONE flat event object (not an array), so there's
 * no batching loop like the direct-Meta version needed.
 *
 * Acknowledges immediately (200) and processes in the background, per
 * the same "don't block the webhook" principle as any provider.
 */
async function receiveWebhook(req, res) {
  res.sendStatus(200); // acknowledge first — everything below is best-effort background work

  try {
    const event = req.body;
    if (!event || !event.customerNumber) {
      logger.debug({ event }, '[webhook] ignored — not a recognizable inbound message event');
      return;
    }

    // Only "direction": "0" (inbound) or events with actual message content
    // are customer messages; outbound delivery-report events (direction "1",
    // or eventName like "sent"/"delivered"/"read") are not something the
    // conversation engine should reply to.
    if (event.direction === '1' || (!event.text && !event.button && !event.interactive && !event.latitude)) {
      logger.debug({ eventName: event.eventName, requestId: event.requestId }, '[webhook] ignored — delivery/status report, not a customer message');
      return;
    }

    await handleSingleMessage(event);
  } catch (err) {
    logger.error({ err: err.message }, '[webhook] processing failed');
  }
}

async function handleSingleMessage(event) {
  const messageId = event.uuid || event.requestId;

  // Duplicate delivery protection (spec section 47): unique index on
  // whatsappMessageId means a second insert throws — treat that as
  // "already processed". If MSG91 ever omits an id, fall back to
  // processing (better to risk a rare duplicate than silently drop it).
  if (messageId) {
    const prisma = getPrisma();
    try {
      await prisma.processedMessage.create({ data: { whatsappMessageId: messageId, whatsappNumber: event.customerNumber } });
    } catch (err) {
      if (err.code === 'P2002') {
        logger.info({ messageId }, '[webhook] duplicate message ignored');
        return;
      }
      throw err;
    }
  }

  const whatsappNumber = normalizeWhatsAppNumber(event.customerNumber);

  if (!perCustomerRateOk(whatsappNumber)) {
    logger.warn({ whatsappNumber }, '[webhook] per-customer rate limit hit — message dropped');
    return;
  }

  // Shows what MSG91 sends when a customer taps a list row or button, so tap handling can be checked against reality.
  logger.info(
    { contentType: event.contentType, text: event.text, interactive: event.interactive, button: event.button },
    '[webhook] inbound message'
  );

  const normalized = normalizeInboundMessage(event);
  await processInboundMessage(whatsappNumber, normalized);
}

module.exports = { receiveWebhook };
