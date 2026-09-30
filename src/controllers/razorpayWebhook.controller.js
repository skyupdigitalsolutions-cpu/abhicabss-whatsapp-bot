const { logger } = require('../config/logger');
const { verifyWebhookSignature } = require('../integrations/razorpay/client');
const { getPrisma } = require('../config/db');
const { wrapSession } = require('../conversation/sessionRecord');
const { notifyPaymentCaptured, notifyPaymentFailed } = require('../conversation/handlers/payment.handler');

function withId(row) {
  return row ? { ...row, _id: row.id } : row;
}

/**
 * POST /webhook/razorpay
 *
 * This is the ONLY place a payment is ever marked CAPTURED or FAILED
 * from an external signal — never from a WhatsApp message. Requires
 * app.js to preserve req.rawBody for signature verification (same
 * pattern as the MSG91 webhook).
 */
async function receiveRazorpayWebhook(req, res) {
  const signature = req.headers['x-razorpay-signature'];
  if (!verifyWebhookSignature(req.rawBody, signature)) {
    logger.warn('[razorpay-webhook] invalid signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  res.sendStatus(200); // acknowledge immediately

  try {
    const prisma = getPrisma();
    const event = req.body.event;
    const paymentEntity = req.body.payload?.payment?.entity;
    if (!paymentEntity) return;

    const payment = await prisma.payment.findUnique({ where: { razorpayOrderId: paymentEntity.order_id } });
    if (!payment) {
      logger.warn({ orderId: paymentEntity.order_id }, '[razorpay-webhook] unknown order');
      return;
    }

    const booking = payment.bookingId
      ? await prisma.booking.findUnique({ where: { id: payment.bookingId } })
      : null;
    const sessionRow = booking
      ? await prisma.session.findUnique({ where: { whatsappNumber: booking.passenger?.phone } })
      : null;
    const session = wrapSession(sessionRow);

    if (event === 'payment.captured') {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'CAPTURED', razorpayPaymentId: paymentEntity.id, verifiedAt: new Date() },
      });
      if (booking) await prisma.booking.update({ where: { id: booking.id }, data: { status: 'CONFIRMED' } });
      if (session && booking) await notifyPaymentCaptured(session, withId(booking));
    } else if (event === 'payment.failed') {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'FAILED', failureReason: paymentEntity.error_description || 'UNKNOWN' },
      });
      if (session && booking) await notifyPaymentFailed(session, withId(booking));
    }
  } catch (err) {
    logger.error({ err: err.message }, '[razorpay-webhook] processing failed');
  }
}

module.exports = { receiveRazorpayWebhook };
