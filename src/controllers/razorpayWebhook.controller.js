const { logger } = require('../config/logger');
const { verifyWebhookSignature } = require('../integrations/razorpay/client');
const { getPrisma } = require('../config/db');
const { wrapSession } = require('../conversation/sessionRecord');
const { applyPaymentCaptured } = require('../integrations/abhicabs/paymentService');
const { notifyPaymentCaptured, notifyPaymentFailed } = require('../conversation/handlers/payment.handler');

function withId(row) {
  return row ? { ...row, _id: row.id } : row;
}

/**
 * Works out which of our Payment rows an event belongs to. For payment links the
 * Payment row stores the link id (plink_...) in `razorpayOrderId`; older order-based
 * payments store the order id there.
 */
async function findPayment(prisma, body) {
  const candidates = [
    body.payload?.payment_link?.entity?.id,
    body.payload?.payment?.entity?.order_id,
    body.payload?.order?.entity?.id,
  ].filter(Boolean);

  for (const id of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const payment = await prisma.payment.findUnique({ where: { razorpayOrderId: id } });
    if (payment) return payment;
  }
  return null;
}

/**
 * Handles one VERIFIED Razorpay event. Exported separately so it can be tested
 * without an HTTP request.
 */
async function processRazorpayEvent(body) {
  const prisma = getPrisma();
  const event = body.event;

  const payment = await findPayment(prisma, body);
  if (!payment) {
    // Normal for payment.captured / payment.failed of a payment link (the link event is the one we use).
    logger.info({ event }, '[razorpay-webhook] no matching payment row — nothing to do');
    return;
  }

  const booking = payment.bookingId ? await prisma.booking.findUnique({ where: { id: payment.bookingId } }) : null;
  const sessionRow = booking?.passenger?.phone
    ? await prisma.session.findUnique({ where: { whatsappNumber: booking.passenger.phone } })
    : null;
  const session = wrapSession(sessionRow);

  const paid = ['payment_link.paid', 'payment.captured', 'order.paid'].includes(event);
  const closedUnpaid = ['payment_link.expired', 'payment_link.cancelled'].includes(event);

  if (paid) {
    const paymentEntity = body.payload?.payment?.entity;
    const linkEntity = body.payload?.payment_link?.entity;
    const amountPaise = paymentEntity?.amount ?? linkEntity?.amount_paid ?? undefined;

    const result = await applyPaymentCaptured({
      paymentId: payment.id,
      razorpayPaymentId: paymentEntity?.id,
      amountPaise,
    });
    if (result.alreadyCaptured) {
      logger.info({ paymentId: payment.id }, '[razorpay-webhook] duplicate delivery ignored');
      return;
    }
    if (session && result.booking) {
      await notifyPaymentCaptured(session, withId(result.booking), result.payment, result.paidRupees);
    }
    return;
  }

  if (closedUnpaid) {
    if (payment.status === 'CAPTURED') return; // never downgrade a paid payment
    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: event === 'payment_link.expired' ? 'TIMEOUT' : 'CANCELLED' },
    });
    if (booking && session && booking.status !== 'CONFIRMED') await notifyPaymentFailed(session, withId(booking));
    return;
  }

  if (event === 'payment.failed') {
    // A failed attempt on a payment link can simply be retried on the same page, so we don't
    // disturb the customer. Only older order-based payments reach here with a matching row.
    if (payment.status !== 'CAPTURED') {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'FAILED', failureReason: body.payload?.payment?.entity?.error_description || 'UNKNOWN' },
      });
    }
  }
}

/**
 * POST /webhook/razorpay
 *
 * This is the ONLY place a payment is ever marked paid from an external signal —
 * never from a WhatsApp message. Requires app.js to preserve req.rawBody for
 * signature verification (same pattern as the MSG91 webhook).
 */
async function receiveRazorpayWebhook(req, res) {
  const signature = req.headers['x-razorpay-signature'];
  if (!verifyWebhookSignature(req.rawBody, signature)) {
    logger.warn('[razorpay-webhook] invalid signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  res.sendStatus(200); // acknowledge immediately

  try {
    await processRazorpayEvent(req.body);
  } catch (err) {
    logger.error({ err: err.message }, '[razorpay-webhook] processing failed');
  }
}

module.exports = { receiveRazorpayWebhook, processRazorpayEvent };
