const { STATES } = require('../states');
const { transition } = require('../sessionManager');
const { t } = require('../../utils/i18n');
const env = require('../../config/env');
const { callTool } = require('../../integrations/ai/tools');
const { paymentIdempotencyKey } = require('../../utils/idempotency');
const { logger } = require('../../config/logger');
const { makeSender } = require('../outbound');
const { toNumbered, rememberOptions } = require('../numberedMenu');
const { fmtDate, fmtTime, fmtDateTime, inr } = require('../../utils/format');

/** Partial Payment = PARTIAL_PAYMENT_PERCENT of the fare (default 25%), at least 1, never more than the fare. */
function partialAmount(total) {
  return Math.min(total, Math.max(1, Math.round((total * env.PARTIAL_PAYMENT_PERCENT) / 100)));
}

function bookingDetailsText(booking) {
  const b = booking;
  const passengers = b.passenger?.passengerCount;
  return (
    `Booking ID: ${b.bookingNumber}\n\n` +
    `${b.passenger?.name || ''}${passengers ? ` · ${passengers} passenger${passengers > 1 ? 's' : ''}` : ''}\n` +
    `Pickup: ${b.pickup?.address}\n` +
    (b.drop?.address ? `Drop: ${b.drop.address}\n` : '') +
    `${fmtDate(b.pickupAt)}\n` +
    `${fmtTime(b.pickupAt)}\n` +
    (b.returnAt ? `Return: ${fmtDateTime(b.returnAt)}\n` : '') +
    `${b.vehicle?.name}\n\n` +
    `Total fare: ${inr(b.fare?.total)}`
  );
}

async function finishAndReturnToMenu(session, send, language) {
  session.resetDraft();
  session.pendingOptionsMap = {};
  await transition(session, STATES.MAIN_MENU);
  await send.buttonsRaw(t(language, 'reply_menu_hint'), [
    { id: 'MENU_MY_BOOKING', title: t(language, 'menu_my_booking') },
    { id: 'MENU_CONTACT', title: t(language, 'menu_contact') },
  ]);
}

/**
 * Called by the Razorpay webhook controller (NOT by anything the customer types)
 * once a payment is verified as paid. Sends: booking details + payment receipt.
 */
async function notifyPaymentCaptured(session, booking, payment, paidRupees) {
  const language = session.language || 'en';
  const send = makeSender(session.whatsappNumber, language);

  const total = booking.fare?.total || 0;
  const paid = paidRupees ?? booking.fare?.amountPaid ?? 0;
  const due = Math.max(0, total - (booking.fare?.amountPaid ?? paid));
  const fullyPaid = due === 0;

  const receipt =
    `Payment Receipt\n` +
    `Receipt No: RCPT-${booking.bookingNumber}-${payment?.attempt || 1}\n` +
    `Date: ${fmtDateTime(new Date())}\n` +
    `Amount paid: ${inr(paid)} (${fullyPaid ? 'Full payment' : 'Partial payment'})\n` +
    (fullyPaid ? `Status: Fully paid\n` : `Balance due: ${inr(due)}\n`) +
    (payment?.razorpayPaymentId ? `Payment ID: ${payment.razorpayPaymentId}` : '');

  await send.raw(
    `${t(language, 'payment_success')}\n\n` +
      `${t(language, 'booking_confirmed_title')}\n` +
      `${bookingDetailsText(booking)}\n\n` +
      `${receipt.trim()}\n\n` +
      `${t(language, 'thank_you_booking')}\n` +
      `${t(language, 'driver_details_later')}`
  );

  session.activePaymentId = payment?._id || session.activePaymentId;
  await finishAndReturnToMenu(session, send, language);
}

/** "Pay Later" chosen: booking is confirmed, nothing charged, full fare stays due. */
async function notifyBookingConfirmedPayLater(session, booking) {
  const language = session.language || 'en';
  const send = makeSender(session.whatsappNumber, language);

  await send.raw(
    `${t(language, 'congratulations')}\n\n` +
      `${t(language, 'booking_confirmed_title')}\n` +
      `${bookingDetailsText(booking)}\n\n` +
      `${t(language, 'booking_confirmed_paylater', { due: inr(booking.fare?.total) })}\n\n` +
      `${t(language, 'thank_you_booking')}\n` +
      `${t(language, 'driver_details_later')}`
  );

  await finishAndReturnToMenu(session, send, language);
}

/** Called by the Razorpay webhook when a payment link expires or is cancelled. */
async function notifyPaymentFailed(session, booking) {
  const language = session.language || 'en';
  const send = makeSender(session.whatsappNumber, language);
  await send.text('payment_link_expired');

  const buttons = [
    { id: 'PAYMENT_RETRY', number: 1, label: t(language, 'retry_payment'), maxTitleLength: 20 },
    { id: 'PAYMENT_CHANGE_METHOD', number: 2, label: t(language, 'change_payment_method'), maxTitleLength: 20 },
    { id: 'PAYMENT_SUPPORT', number: 3, label: t(language, 'contact_support'), maxTitleLength: 20 },
  ];
  const { rows, map } = toNumbered(buttons);
  await send.buttonsRaw(t(language, 'payment_failed'), rows.map((r) => ({ id: r.id, title: r.title })));

  await transition(session, STATES.PAYMENT_PENDING);
  await rememberOptions(session, map);
}

// ── Select Payment Option ───────────────────────────────────────────

async function showPaymentOptions(ctx, booking) {
  const { session, language } = ctx;

  if (booking.status === 'CONFIRMED') {
    await notifyBookingConfirmedPayLater(session, booking);
    return;
  }

  const total = booking.fare.total;
  await transition(session, STATES.BOOKING_CREATED);

  const body = t(language, 'payment_options_body', {
    bookingNumber: booking.bookingNumber,
    total: inr(total),
    partial: inr(partialAmount(total)),
    percent: env.PARTIAL_PAYMENT_PERCENT,
    zero: inr(0),
  });
  const buttons = [
    { id: 'PAY_LATER', number: 1, label: t(language, 'btn_pay_later'), maxTitleLength: 20 },
    { id: 'PAY_PARTIAL', number: 2, label: t(language, 'btn_pay_partial'), maxTitleLength: 20 },
    { id: 'PAY_FULL', number: 3, label: t(language, 'btn_pay_full'), maxTitleLength: 20 },
  ];
  const { rows, map } = toNumbered(buttons);

  await ctx.send.buttonsRaw(body, rows.map((r) => ({ id: r.id, title: r.title })));
  await rememberOptions(session, map);
}

async function handlePaymentOption(ctx) {
  const { message, session } = ctx;
  const typed = (message.text || '').trim();

  let choice = ['PAY_LATER', 'PAY_PARTIAL', 'PAY_FULL'].includes(message.interactiveId) ? message.interactiveId : null;
  if (!choice) {
    if (/later/i.test(typed)) choice = 'PAY_LATER';
    else if (/partial/i.test(typed)) choice = 'PAY_PARTIAL';
    else if (/full/i.test(typed)) choice = 'PAY_FULL';
  }

  const booking = await callTool('getBooking', session.activeBookingId);
  if (!booking) {
    await ctx.send.text('booking_api_failed');
    return;
  }

  if (!choice) {
    await showPaymentOptions(ctx, booking);
    return;
  }

  if (choice === 'PAY_LATER') {
    let confirmed;
    try {
      confirmed = await callTool('markBookingPayLater', booking._id);
    } catch (err) {
      logger.error({ err: err.message }, '[payment] pay-later confirmation failed');
      await ctx.send.text('booking_api_failed');
      return;
    }
    await notifyBookingConfirmedPayLater(session, confirmed);
    return;
  }

  await sendPaymentLink(ctx, booking, choice === 'PAY_PARTIAL' ? 'PARTIAL' : 'FULL');
}

// ── Razorpay payment link ───────────────────────────────────────────

async function sendPaymentLink(ctx, booking, mode) {
  const { session } = ctx;
  const total = booking.fare.total;
  const amount = mode === 'FULL' ? total : partialAmount(total);

  const attempt = (await callTool('countPaymentAttemptsForBooking', booking._id)) + 1;
  const idempotencyKey = paymentIdempotencyKey(booking._id, attempt);

  let result;
  try {
    result = await callTool('createPaymentLink', {
      bookingId: booking._id,
      amountInRupees: amount,
      mode,
      attempt,
      idempotencyKey,
      customerName: booking.passenger?.name,
    });
  } catch (err) {
    logger.error({ err: err.message }, '[payment] createPaymentLink failed');
    await ctx.send.text('payment_link_failed');
    await showPaymentOptions(ctx, booking);
    return;
  }

  session.activePaymentId = result.payment._id;
  session.pendingOptionsMap = {};
  await transition(session, STATES.PAYMENT_PENDING);

  await ctx.send.text('payment_link_message', {
    amount: inr(amount),
    bookingNumber: booking.bookingNumber,
    url: result.paymentUrl,
  });
}

async function handlePaymentPendingReply(ctx) {
  const { message, session } = ctx;
  const id = message.interactiveId;
  const typed = (message.text || '').trim().toLowerCase();

  if (id === 'PAYMENT_SUPPORT') {
    const { escalateToHuman } = require('./handoff.handler');
    await escalateToHuman(ctx, 'PAYMENT_ISSUE', { category: 'PAYMENT_ISSUE', bookingId: session.activeBookingId });
    return;
  }

  const wantsRetry = id === 'PAYMENT_RETRY' || /^(retry|new link|resend|link)$/.test(typed);
  const wantsOptions = id === 'PAYMENT_CHANGE_METHOD' || /^(change|options?)$/.test(typed);

  if (wantsRetry || wantsOptions) {
    const booking = await callTool('getBooking', session.activeBookingId);
    if (!booking) {
      await ctx.send.text('booking_api_failed');
      return;
    }
    if (wantsOptions) {
      await showPaymentOptions(ctx, booking);
    } else {
      await sendPaymentLink(ctx, booking, booking.fare?.paymentMode === 'FULL' ? 'FULL' : 'PARTIAL');
    }
    return;
  }

  await ctx.send.text('payment_verifying');
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
  partialAmount,
  showPaymentOptions,
  handlePaymentOption,
  sendPaymentLink,
  notifyPaymentCaptured,
  notifyBookingConfirmedPayLater,
  notifyPaymentFailed,
  handlePaymentPendingReply,
  handlePaymentStatusQuery,
};
