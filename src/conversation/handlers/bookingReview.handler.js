const { STATES } = require('../states');
const { transition } = require('../sessionManager');
const { t } = require('../../utils/i18n');
const { callTool } = require('../../integrations/ai/tools');
const { bookingIdempotencyKey, paymentIdempotencyKey } = require('../../utils/idempotency');
const { logger } = require('../../config/logger');
const dayjs = require('dayjs');
const { toNumbered, rememberOptions } = require('../numberedMenu');

async function handleBookingCustomerName(ctx) {
  const { message, session, customer } = ctx;
  const name = (message.text || '').trim();

  if (!name || name.length < 2) {
    await ctx.send.text('ask_name');
    return;
  }

  session.draft.passengerName = name;
  customer.name = name;
  await customer.save();
  await session.save();

  await showBookingReview(ctx);
}

async function showBookingReview(ctx) {
  const { session } = ctx;
  const d = session.draft;

  await transition(session, STATES.BOOKING_REVIEW);

  const dateStr = dayjs(d.pickupAt).tz ? dayjs(d.pickupAt).format('DD MMM YYYY') : dayjs(d.pickupAt).format('DD MMM YYYY');
  const timeStr = dayjs(d.pickupAt).format('h:mm A');

  const body =
    `${t(ctx.language, 'booking_summary_title')}\n\n` +
    `👤 ${d.passengerName}\n` +
    `📱 ${session.whatsappNumber}\n\n` +
    `📍 ${d.pickup.address}\n` +
    (d.drop.address ? `📍 ${d.drop.address}\n` : '') +
    `📅 ${dateStr}\n` +
    `⏰ ${timeStr}\n` +
    (d.returnAt ? `↩️ Return: ${dayjs(d.returnAt).format('DD MMM YYYY, h:mm A')}\n` : '') +
    (d.rentalHours ? `🕒 ${d.rentalHours} hours\n` : '') +
    `🚗 ${d.vehicleClass}\n` +
    `👥 ${d.passengerCount} passengers\n\n` +
    `💰 Total: ₹${d.fare.total}`;

  const buttons = [
    { id: 'REVIEW_CONFIRM', number: 1, label: t(ctx.language, 'confirm_and_pay'), maxTitleLength: 20 },
    { id: 'REVIEW_MODIFY', number: 2, label: t(ctx.language, 'modify'), maxTitleLength: 20 },
    { id: 'REVIEW_CANCEL', number: 3, label: t(ctx.language, 'cancel'), maxTitleLength: 20 },
  ];
  const { rows, map } = toNumbered(buttons);

  await ctx.send.buttonsRaw(body, rows.map((r) => ({ id: r.id, title: r.title })));
  await rememberOptions(session, map);
}

async function handleBookingReview(ctx) {
  const { message, session } = ctx;

  if (message.interactiveId === 'REVIEW_MODIFY') {
    const { promptTripType } = require('./booking.handler');
    session.resetDraft();
    await transition(session, STATES.BOOKING_TRIP_TYPE);
    await promptTripType(ctx);
    return;
  }

  if (message.interactiveId === 'REVIEW_CANCEL') {
    session.resetDraft();
    const { renderMainMenu } = require('./mainMenu.handler');
    await transition(session, STATES.MAIN_MENU);
    await renderMainMenu(ctx);
    return;
  }

  // REVIEW_CONFIRM (default)
  await createBookingAndStartPayment(ctx);
}

async function createBookingAndStartPayment(ctx) {
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
  await transition(session, STATES.BOOKING_CREATED);
  await ctx.send.text('booking_created');

  await startPayment(ctx, booking);
}

async function startPayment(ctx, booking) {
  const { session } = ctx;
  const attempt = 1;
  const payIdemKey = paymentIdempotencyKey(booking._id, attempt);

  let order;
  try {
    order = await callTool('createPaymentOrder', {
      bookingId: booking._id,
      amountInRupees: booking.fare.total,
      idempotencyKey: payIdemKey,
      attempt,
    });
  } catch (err) {
    logger.error({ err: err.message }, '[payment] createPaymentOrder failed');
    await ctx.send.text('booking_api_failed');
    return;
  }

  session.activePaymentId = order._id;
  await transition(session, STATES.PAYMENT_PENDING);
  session.pendingOptionsMap = {}; // no menu shown yet — cleared until a failure prompts retry buttons
  await session.save();

  await ctx.send.text('amount_payable', { amount: booking.fare.total });

  // In production, generate a Razorpay Checkout link/page (e.g. via
  // Payment Links API) and send that URL here, OR hand the order.id +
  // key_id to a WhatsApp Flow / mini-checkout webview. The customer
  // completing checkout there is what ultimately calls back to
  // /webhook/razorpay, which is the only thing allowed to mark this
  // payment CAPTURED (see paymentService.verifyAndCapturePayment).
  await ctx.send.raw(
    `${t(ctx.language, 'please_pay')}\n\nOrder ID: ${order.razorpayOrderId}`
  );
}

module.exports = {
  handleBookingCustomerName,
  showBookingReview,
  handleBookingReview,
  createBookingAndStartPayment,
  startPayment,
};
