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

/**
 * createPaymentLink — creates a Razorpay Payment Link for a booking and records
 * it as a Payment row. For link payments the Payment row's `razorpayOrderId`
 * column holds the link id (plink_...), which is what the webhook looks up.
 * Idempotent on idempotencyKey: retrying returns the same link, never a second one.
 *
 * mode: 'PARTIAL' | 'FULL' (stored on the booking so the receipt can say which).
 */
async function createPaymentLink({ bookingId, amountInRupees, mode, attempt = 1, idempotencyKey, customerName }) {
  const prisma = getPrisma();

  const existing = await prisma.payment.findUnique({ where: { idempotencyKey } });
  if (existing) {
    const link = await razorpayClient.fetchPaymentLink(existing.razorpayOrderId);
    return { payment: withId(existing), paymentUrl: link.short_url };
  }

  const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
  if (!booking) throw new Error('BOOKING_NOT_FOUND');

  const link = await razorpayClient.createPaymentLink({
    amountInRupees,
    referenceId: `${booking.bookingNumber}-${attempt}`,
    description: `ABHI CABS booking ${booking.bookingNumber}`,
    customerName: customerName || booking.passenger?.name,
    customerPhone: booking.passenger?.phone,
    notes: { bookingId: String(bookingId), bookingNumber: booking.bookingNumber, mode },
  });

  const payment = await prisma.payment.create({
    data: {
      bookingId,
      razorpayOrderId: link.id,
      amount: Math.round(amountInRupees * 100),
      currency: 'INR',
      status: 'CREATED',
      attempt,
      idempotencyKey,
    },
  });

  await prisma.booking.update({
    where: { id: bookingId },
    data: {
      paymentId: payment.id,
      status: 'PAYMENT_PENDING',
      fare: { ...booking.fare, paymentMode: mode, amountPaid: 0, amountDue: booking.fare.total },
    },
  });

  return { payment: withId(payment), paymentUrl: link.short_url };
}

/** "Pay Later": nothing is charged now, the booking is confirmed and the full fare stays due. */
async function markBookingPayLater(bookingId) {
  const prisma = getPrisma();
  const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
  if (!booking) throw new Error('BOOKING_NOT_FOUND');
  const updated = await prisma.booking.update({
    where: { id: bookingId },
    data: {
      status: 'CONFIRMED',
      fare: { ...booking.fare, paymentMode: 'PAY_LATER', amountPaid: 0, amountDue: booking.fare.total },
    },
  });
  return withId(updated);
}

/**
 * applyPaymentCaptured — called ONLY after the Razorpay webhook signature has been
 * verified. Atomically flips the payment to CAPTURED (so a webhook that Razorpay
 * delivers twice only confirms the booking once) and confirms the booking.
 * Returns { alreadyCaptured: true } for the duplicate delivery.
 */
async function applyPaymentCaptured({ paymentId, razorpayPaymentId, amountPaise }) {
  const prisma = getPrisma();

  const flipped = await prisma.payment.updateMany({
    where: { id: paymentId, status: { not: 'CAPTURED' } },
    data: { status: 'CAPTURED', razorpayPaymentId: razorpayPaymentId || null, verifiedAt: new Date() },
  });
  if (flipped.count === 0) return { alreadyCaptured: true };

  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  const paidRupees = Math.round((amountPaise ?? payment.amount) / 100);
  if (amountPaise != null && amountPaise !== payment.amount) {
    // eslint-disable-next-line no-console
    console.warn(`[payment] amount mismatch for ${paymentId}: expected ${payment.amount} paise, Razorpay reported ${amountPaise}`);
  }

  let booking = payment.bookingId ? await prisma.booking.findUnique({ where: { id: payment.bookingId } }) : null;
  if (booking) {
    const total = booking.fare?.total || 0;
    const previouslyPaid = booking.fare?.amountPaid || 0;
    const amountPaid = previouslyPaid + paidRupees;
    booking = await prisma.booking.update({
      where: { id: booking.id },
      data: {
        status: 'CONFIRMED',
        fare: {
          ...booking.fare,
          paymentMode: booking.fare?.paymentMode || (amountPaid >= total ? 'FULL' : 'PARTIAL'),
          amountPaid,
          amountDue: Math.max(0, total - amountPaid),
        },
      },
    });
  }

  return { alreadyCaptured: false, payment: withId(payment), booking: withId(booking), paidRupees };
}

module.exports = {
  createPaymentOrder,
  verifyAndCapturePayment,
  getPaymentStatus,
  countPaymentAttemptsForBooking,
  createPaymentLink,
  markBookingPayLater,
  applyPaymentCaptured,
};
