const { STATES } = require('../states');
const { transition } = require('../sessionManager');
const { t } = require('../../utils/i18n');
const { callTool } = require('../../integrations/ai/tools');
const { bookingIdempotencyKey } = require('../../utils/idempotency');
const { logger } = require('../../config/logger');
const { fmtDate, fmtTime, fmtDateTime, inr } = require('../../utils/format');
const { toNumbered, rememberOptions } = require('../numberedMenu');

// ── Passenger details: name, then number of passengers (asked in booking.handler.js) ──

async function handleBookingCustomerName(ctx) {
  const { message, session, customer } = ctx;
  const name = (message.text || '').trim();

  if (!name || name.length < 2 || name.length > 60) {
    await ctx.send.text('ask_name');
    return;
  }

  session.draft.passengerName = name;
  customer.name = name;
  await customer.save();
  await session.save();

  await transition(session, STATES.BOOKING_PASSENGERS);
  await ctx.send.text('ask_passenger_count');
}

// ── Booking summary ─────────────────────────────────────────────────

async function showBookingReview(ctx) {
  const { session } = ctx;
  const d = session.draft;

  await transition(session, STATES.BOOKING_REVIEW);

  const body =
    `${t(ctx.language, 'booking_summary_title')}\n\n` +
    `👤 ${d.passengerName}\n` +
    `📱 ${session.whatsappNumber}\n` +
    `👥 ${d.passengerCount} passenger${d.passengerCount > 1 ? 's' : ''}\n\n` +
    `📍 Pickup: ${d.pickup.address}\n` +
    (d.drop?.address ? `🏁 Drop: ${d.drop.address}\n` : '') +
    `📅 ${fmtDate(d.pickupAt)}\n` +
    `⏰ ${fmtTime(d.pickupAt)}\n` +
    (d.returnAt ? `↩️ Return: ${fmtDateTime(d.returnAt)}\n` : '') +
    (d.rentalHours ? `🕒 ${d.rentalHours} hours\n` : '') +
    `🚗 ${d.vehicleName || d.vehicleClass}\n\n` +
    `💰 Total fare: ${inr(d.fare.total)}`;

  const buttons = [
    { id: 'REVIEW_CONFIRM', number: 1, label: t(ctx.language, 'confirm_booking'), maxTitleLength: 20 },
    { id: 'REVIEW_MODIFY', number: 2, label: t(ctx.language, 'modify'), maxTitleLength: 20 },
    { id: 'REVIEW_CANCEL', number: 3, label: t(ctx.language, 'cancel'), maxTitleLength: 20 },
  ];
  const { rows, map } = toNumbered(buttons);

  await ctx.send.buttonsRaw(body, rows.map((r) => ({ id: r.id, title: r.title })));
  await rememberOptions(session, map);
}

async function handleBookingReview(ctx) {
  const { message, session } = ctx;
  const typed = (message.text || '').trim();

  if (message.interactiveId === 'REVIEW_MODIFY' || /\b(modify|change|edit)\b/i.test(typed)) {
    const { startBooking } = require('./booking.handler');
    await startBooking(ctx);
    return;
  }

  if (message.interactiveId === 'REVIEW_CANCEL' || /\bcancel\b/i.test(typed)) {
    session.resetDraft();
    await ctx.send.text('booking_cancelled');
    const { renderMainMenu } = require('./mainMenu.handler');
    await transition(session, STATES.MAIN_MENU);
    await renderMainMenu(ctx);
    return;
  }

  // Only an explicit Confirm creates a booking — stray text never does.
  if (message.interactiveId === 'REVIEW_CONFIRM' || /\bconfirm\b/i.test(typed) || /^(yes|ok|y)$/i.test(typed)) {
    await createBookingAndShowPaymentOptions(ctx);
    return;
  }

  await showBookingReview(ctx);
}

// ── Confirm Booking → save it → Select Payment Option ───────────────

async function createBookingAndShowPaymentOptions(ctx) {
  const { session, customer } = ctx;
  const d = session.draft;

  const idempotencyKey = bookingIdempotencyKey(String(session._id), d);
  session.pendingIdempotencyKey = idempotencyKey;
  await session.save();

  let result;
  try {
    result = await callTool('createBooking', {
      idempotencyKey,
      customerId: customer._id,
      passenger: {
        name: d.passengerName,
        phone: session.whatsappNumber,
        email: d.passengerEmail,
        passengerCount: d.passengerCount,
      },
      customerType: customer.customerType,
      companyName: customer.companyName,
      gstNumber: customer.gstNumber,
      tripType: d.tripType,
      pickup: d.pickup,
      drop: d.drop,
      pickupAt: d.pickupAt,
      returnAt: d.returnAt,
      rentalHours: d.rentalHours,
      vehicleId: d.vehicleId,
      fareQuoteId: d.fareQuoteId,
      specialRequests: d.specialRequests,
    });
  } catch (err) {
    logger.error({ err: err.message }, '[booking] createBooking failed');
    await ctx.send.text('booking_api_failed');
    return;
  }

  const { booking } = result;
  session.activeBookingId = booking._id;
  await session.save();

  const { showPaymentOptions } = require('./payment.handler');
  await showPaymentOptions(ctx, booking);
}

module.exports = {
  handleBookingCustomerName,
  showBookingReview,
  handleBookingReview,
  createBookingAndShowPaymentOptions,
  createBookingAndStartPayment: createBookingAndShowPaymentOptions, // old name, kept for compatibility
};
