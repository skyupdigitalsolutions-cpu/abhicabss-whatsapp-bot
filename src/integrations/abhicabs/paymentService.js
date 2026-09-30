const env = require('../../config/env');
const { getPrisma } = require('../../config/db');
const backendHttp = require('./backendHttp');
const razorpayClient = require('../razorpay/client');

function withId(row) {
  return row ? { ...row, _id: row.id } : row;
}

/**
 * createPaymentOrder — equivalent of POST /payments/orders. Idempotent
 * on idempotencyKey (usually `pay:<bookingId>:<attempt>`), so retrying
 * a failed request never creates two orders for the same charge.
 */
async function createPaymentOrder({ bookingId, amountInRupees, idempotencyKey, attempt = 1 }) {
  const prisma = getPrisma();

  const existing = await prisma.payment.findUnique({ where: { idempotencyKey } });
  if (existing) return withId(existing);

  if (env.BACKEND_MODE === 'remote') {
    const { data } = await backendHttp.post(
      '/payments/orders',
      { bookingId, amount: amountInRupees },
      { headers: { 'Idempotency-Key': idempotencyKey } }
    );
    const payment = await prisma.payment.create({ data: { ...data, bookingId, idempotencyKey, attempt } });
    await prisma.booking.update({ where: { id: bookingId }, data: { paymentId: payment.id, status: 'PAYMENT_PENDING' } });
    return withId(payment);
  }

  const order = await razorpayClient.createOrder({
    amountInRupees,
    receipt: idempotencyKey,
    notes: { bookingId: String(bookingId) },
  });

  const payment = await prisma.payment.create({
    data: {
      bookingId,
      razorpayOrderId: order.id,
      amount: order.amount,
      currency: order.currency,
      status: 'CREATED',
      attempt,
      idempotencyKey,
    },
  });

  await prisma.booking.update({
    where: { id: bookingId },
    data: { paymentId: payment.id, status: 'PAYMENT_PENDING' },
  });

  return withId(payment);
}

/**
 * verifyAndCapturePayment — the ONLY function allowed to mark a payment
 * CAPTURED. Requires a valid Razorpay signature (Checkout callback) or
 * a verified webhook event. A customer saying "I paid" in chat is
 * NEVER sufficient and must never reach this function directly.
 */
async function verifyAndCapturePayment({ razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
  const prisma = getPrisma();

  const valid = razorpayClient.verifyCheckoutSignature({
    razorpayOrderId,
    razorpayPaymentId,
    razorpaySignature,
  });

  const payment = await prisma.payment.findUnique({ where: { razorpayOrderId } });
  if (!payment) throw new Error('PAYMENT_ORDER_NOT_FOUND');

  if (!valid) {
    const updated = await prisma.payment.update({
      where: { id: payment.id },
      data: { status: 'FAILED', failureReason: 'SIGNATURE_VERIFICATION_FAILED' },
    });
    return withId(updated);
  }

  // Double-check against Razorpay's own record rather than trusting the
  // callback payload alone.
  const remote = await razorpayClient.fetchPayment(razorpayPaymentId);
  if (remote.status !== 'captured') {
    const updated = await prisma.payment.update({
      where: { id: payment.id },
      data: { status: remote.status === 'failed' ? 'FAILED' : 'PENDING', razorpayPaymentId },
    });
    return withId(updated);
  }

  const updated = await prisma.payment.update({
    where: { id: payment.id },
    data: {
      status: 'CAPTURED',
      razorpayPaymentId,
      razorpaySignature,
      verifiedAt: new Date(),
    },
  });

  const booking = await prisma.booking.findUnique({ where: { paymentId: payment.id } });
  if (booking) {
    await prisma.booking.update({ where: { id: booking.id }, data: { status: 'CONFIRMED' } });
  }

  return withId(updated);
}

async function getPaymentStatus(paymentId) {
  if (env.BACKEND_MODE === 'remote') {
    const { data } = await backendHttp.get(`/payments/${paymentId}`);
    return data;
  }
  const prisma = getPrisma();
  return withId(await prisma.payment.findUnique({ where: { id: paymentId } }));
}

/** Count of previous payment attempts for a booking, used to pick the next `attempt` number on retry. */
async function countPaymentAttemptsForBooking(bookingId) {
  const prisma = getPrisma();
  return prisma.payment.count({ where: { bookingId } });
}

module.exports = { createPaymentOrder, verifyAndCapturePayment, getPaymentStatus, countPaymentAttemptsForBooking };
