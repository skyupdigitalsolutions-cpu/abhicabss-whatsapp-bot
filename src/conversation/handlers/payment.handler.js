const dayjs = require('dayjs');
const { STATES } = require('../states');
const { transition } = require('../sessionManager');
const { t } = require('../../utils/i18n');
const { callTool } = require('../../integrations/ai/tools');
const { paymentIdempotencyKey } = require('../../utils/idempotency');
const { getPrisma } = require('../../config/db');
const { makeSender } = require('../outbound');
const { toNumbered, rememberOptions } = require('../numberedMenu');

/**
 * Called by the Razorpay webhook controller (NOT by anything the
 * customer types) once a payment is verified as CAPTURED. This is the
 * only path that sends the "Booking Confirmed" message — the bot
 * itself never marks a booking confirmed from chat text.
 */
async function notifyPaymentCaptured(session, booking) {
  const send = makeSender(session.whatsappNumber, session.language);
  await transition(session, STATES.BOOKING_CONFIRMED);

  const body =
    `${t(session.language, 'thank_you_booking')}\n` +
    `${t(session.language, 'congratulations')}\n\n` +
    `${t(session.language, 'payment_success')}\n\n` +
    `${t(session.language, 'booking_confirmed_title')}\n\n` +
    `Booking ID: ${booking.bookingNumber}\n\n` +
    `📍 ${booking.pickup.address}${booking.drop?.address ? ' → ' + booking.drop.address : ''}\n` +
    `📅 ${dayjs(booking.pickupAt).format('DD MMM YYYY')}\n` +
    `⏰ ${dayjs(booking.pickupAt).format('h:mm A')}\n` +
    `🚗 ${booking.vehicle.name}\n` +
    `💰 Paid: ₹${booking.fare.total}\n\n` +
    `Driver details will be shared once assigned.`;

  await send.raw(body);
  await send.buttonsRaw(t(session.language, 'menu_my_booking'), [
    { id: 'MENU_MY_BOOKING', title: t(session.language, 'menu_my_booking') },
    { id: 'MENU_TRACK_BOOKING', title: t(session.language, 'menu_track_booking') },
    { id: 'MENU_SUPPORT', title: t(session.language, 'menu_support') },
  ]);
}

/** Called by the Razorpay webhook controller when a payment fails/times out. */
async function notifyPaymentFailed(session, booking) {
  const send = makeSender(session.whatsappNumber, session.language);
  await send.text('payment_failed');

  const buttons = [
    { id: 'PAYMENT_RETRY', number: 1, label: t(session.language, 'retry_payment'), maxTitleLength: 20 },
    { id: 'PAYMENT_CHANGE_METHOD', number: 2, label: t(session.language, 'change_payment_method'), maxTitleLength: 20 },
    { id: 'PAYMENT_SUPPORT', number: 3, label: t(session.language, 'contact_support'), maxTitleLength: 20 },
  ];
  const { rows, map } = toNumbered(buttons);
  await send.buttonsRaw(t(session.language, 'payment_failed'), rows.map((r) => ({ id: r.id, title: r.title })));
  await rememberOptions(session, map);
}

async function handlePaymentPendingReply(ctx) {
  const { message, session } = ctx;

  if (message.interactiveId === 'PAYMENT_RETRY' || message.interactiveId === 'PAYMENT_CHANGE_METHOD') {
    const booking = await callTool('getBooking', session.activeBookingId);
    if (!booking) {
      await ctx.send.text('booking_api_failed');
      return;
    }
    const { startPayment } = require('./bookingReview.handler');
    // Bump attempt count so the idempotency key differs from the failed one.
    const attempt = (await callTool('countPaymentAttemptsForBooking', booking._id)) + 1;
    await startPaymentWithAttempt(ctx, booking, attempt);
    return;
  }

  if (message.interactiveId === 'PAYMENT_SUPPORT') {
    const { escalateToHuman } = require('./handoff.handler');
    await escalateToHuman(ctx, 'PAYMENT_ISSUE', { category: 'PAYMENT_ISSUE', bookingId: session.activeBookingId });
    return;
  }

  // Anything else while payment is pending — remind them verification is manual/backend-driven.
  await ctx.send.text('payment_verifying');
}

async function startPaymentWithAttempt(ctx, booking, attempt) {
  const { session } = ctx;
  const idemKey = paymentIdempotencyKey(booking._id, attempt);
  const order = await callTool('createPaymentOrder', {
    bookingId: booking._id,
    amountInRupees: booking.fare.total,
    idempotencyKey: idemKey,
    attempt,
  });
  session.activePaymentId = order._id;
  session.pendingOptionsMap = {};
  await session.save();
  await ctx.send.text('amount_payable', { amount: booking.fare.total });
  await ctx.send.raw(`${t(ctx.language, 'please_pay')}\n\nOrder ID: ${order.razorpayOrderId}`);
}

async function handlePaymentStatusQuery(ctx) {
  const { session } = ctx;
  if (!session.activePaymentId) {
    await ctx.send.text('no_bookings_found');
    return;
  }
  const payment = await callTool('getPaymentStatus', session.activePaymentId);
  const statusMessages = {
    CREATED: 'payment_verifying',
    PENDING: 'payment_verifying',
    CAPTURED: 'payment_success',
    FAILED: 'payment_failed',
    TIMEOUT: 'payment_failed',
    CANCELLED: 'payment_failed',
  };
  await ctx.send.text(statusMessages[payment.status] || 'generic_error');
}

module.exports = {
  notifyPaymentCaptured,
  notifyPaymentFailed,
  handlePaymentPendingReply,
  handlePaymentStatusQuery,
};
