const { STATES } = require('./states');
const { getOrCreateSession, touchSession } = require('./sessionManager');
const { makeSender } = require('./outbound');
const { t } = require('../utils/i18n');
const { logger } = require('../config/logger');

const { promptLanguageSelection, handleLanguageSelection } = require('./handlers/language.handler');
const { renderMainMenu, handleMainMenu } = require('./handlers/mainMenu.handler');
const {
  handleBookingTripType,
  handleBookingPickup,
  handleBookingDrop,
  handleBookingDate,
  handleBookingTime,
  handleBookingReturnDate,
  handleBookingReturnTime,
  handleBookingRentalHours,
  handleBookingPassengers,
  handleBookingVehicleSelection,
  handleBookingFareConfirmation,
} = require('./handlers/booking.handler');
const {
  handleBookingCustomerName,
  handleBookingReview,
} = require('./handlers/bookingReview.handler');
const { handlePaymentPendingReply } = require('./handlers/payment.handler');
const { showMyBookings, handleBookingDetailsSelection } = require('./handlers/myBookings.handler');
const {
  handleCancellationReason,
  handleCancellationConfirmation,
} = require('./handlers/cancellation.handler');
const { handleSupportCategory, handleSupportMessage } = require('./handlers/support.handler');
const { routeFromIntent } = require('./handlers/nluRouter');
const { resolveNumericSelection, toNumbered, rememberOptions } = require('./numberedMenu');

/**
 * States where the last thing sent to the customer was a numbered
 * menu (list or buttons) — these are the only states where a bare
 * digit reply ("1", "2") is resolved against session.pendingOptionsMap.
 * Everywhere else a digit is treated as ordinary free text (a
 * passenger count, part of an address, a rental-hours answer, etc.)
 * so it's never misinterpreted as a stale menu selection.
 */
const NUMBERED_MENU_STATES = new Set([
  STATES.LANGUAGE_SELECTION,
  STATES.MAIN_MENU,
  STATES.BOOKING_TRIP_TYPE,
  STATES.BOOKING_VEHICLE_SELECTION,
  STATES.BOOKING_FARE_CONFIRMATION,
  STATES.BOOKING_REVIEW,
  STATES.MY_BOOKINGS,
  STATES.BOOKING_DETAILS,
  STATES.PAYMENT_PENDING,
  STATES.CANCELLATION_CONFIRMATION,
  STATES.SUPPORT_CATEGORY,
  STATES.SESSION_EXPIRED,
]);

/**
 * One handler per state. Every handler receives the same `ctx` shape:
 *   { session, customer, message, language, send, fareOnly? }
 * and is responsible for reading the inbound message, updating the
 * session/draft, calling backend tools as needed, and sending the
 * next WhatsApp message(s). The router itself contains NO business
 * logic — it only dispatches by `session.state`.
 */
const STATE_HANDLERS = {
  [STATES.LANGUAGE_SELECTION]: handleLanguageSelection,
  [STATES.MAIN_MENU]: handleMainMenu,

  [STATES.BOOKING_TRIP_TYPE]: handleBookingTripType,
  [STATES.BOOKING_PICKUP]: handleBookingPickup,
  [STATES.BOOKING_DROP]: handleBookingDrop,
  [STATES.BOOKING_DATE]: handleBookingDate,
  [STATES.BOOKING_TIME]: handleBookingTime,
  [STATES.BOOKING_RETURN_DATE]: handleBookingReturnDate,
  [STATES.BOOKING_RETURN_TIME]: handleBookingReturnTime,
  [STATES.BOOKING_RENTAL_HOURS]: handleBookingRentalHours,
  [STATES.BOOKING_PASSENGERS]: handleBookingPassengers,
  [STATES.BOOKING_VEHICLE_SELECTION]: handleBookingVehicleSelection,
  [STATES.BOOKING_FARE_CONFIRMATION]: handleBookingFareConfirmation,
  [STATES.BOOKING_CUSTOMER_NAME]: handleBookingCustomerName,
  [STATES.BOOKING_REVIEW]: handleBookingReview,

  [STATES.PAYMENT_PENDING]: handlePaymentPendingReply,

  [STATES.MY_BOOKINGS]: showMyBookings,
  [STATES.BOOKING_DETAILS]: handleBookingDetailsSelection,

  [STATES.CANCELLATION_REASON]: handleCancellationReason,
  [STATES.CANCELLATION_CONFIRMATION]: handleCancellationConfirmation,

  [STATES.SUPPORT_CATEGORY]: handleSupportCategory,
  [STATES.SUPPORT_MESSAGE]: handleSupportMessage,
};

/** Intents that are always allowed to interrupt an in-progress flow (spec section 40). */
const GLOBAL_INTERRUPT_KEYWORDS = /^(menu|cancel|help|support|human|agent)$/i;

async function handleSessionExpired(ctx) {
  const { message, session } = ctx;
  const { transition } = require('./sessionManager');

  if (message.interactiveId === 'RESUME_CONTINUE') {
    await transition(session, session.previousState || STATES.MAIN_MENU);
    await ctx.send.raw('Continuing your previous booking...');
    return;
  }

  session.resetDraft();
  await transition(session, STATES.MAIN_MENU);
  await renderMainMenu(ctx);
}

async function handleHumanHandoff(ctx) {
  // Per spec section 29: once handed off, the bot stays silent unless
  // reconfigured — a staff member is expected to take over. We do not
  // auto-reply here at all.
  logger.info(
    { whatsappNumber: ctx.session.whatsappNumber },
    '[handoff] message received while in HUMAN_HANDOFF — no automated reply sent'
  );
}

/**
 * Entry point called by the webhook controller for every normalized
 * inbound message. Handles session load, global interrupts, dispatch,
 * and always touches lastMessageAt so timeout logic stays accurate.
 */
async function processInboundMessage(whatsappNumber, normalizedMessage) {
  const { session, customer, wasExpired } = await getOrCreateSession(whatsappNumber);
  const language = session.language || 'en';
  const send = makeSender(whatsappNumber, language);

  const ctx = { session, customer, message: normalizedMessage, language, send };

  // Resolve a bare-digit reply ("1", "2") back to the tapped-equivalent
  // id, but only in states that actually just showed a numbered menu —
  // see NUMBERED_MENU_STATES above.
  if (NUMBERED_MENU_STATES.has(session.state)) {
    const resolvedId = resolveNumericSelection(session, normalizedMessage);
    if (resolvedId) {
      normalizedMessage.interactiveId = resolvedId;
    }
  }

  if (wasExpired && session.state === STATES.SESSION_EXPIRED) {
    const { rows, map } = toNumbered([
      { id: 'RESUME_CONTINUE', number: 1, label: t(language, 'continue_previous') },
      { id: 'RESUME_NEW', number: 2, label: t(language, 'start_new_booking') },
    ]);
    await send.buttonsRaw(t(language, 'session_resume_prompt'), rows.map((r) => ({ id: r.id, title: r.title })));
    await rememberOptions(session, map);
    await touchSession(session);
    return;
  }

  if (session.state === STATES.SESSION_EXPIRED) {
    if (normalizedMessage.interactiveId === 'RESUME_NEW') {
      const { transition } = require('./sessionManager');
      session.resetDraft();
      await transition(session, STATES.MAIN_MENU);
      await renderMainMenu(ctx);
    } else {
      await handleSessionExpired(ctx);
    }
    await touchSession(session);
    return;
  }

  if (session.humanHandoff || session.state === STATES.HUMAN_HANDOFF) {
    await handleHumanHandoff(ctx);
    await touchSession(session);
    return;
  }

  // Global interrupts: "menu" / "cancel" / "help" / "human" work from anywhere.
  const text = normalizedMessage.text || normalizedMessage.interactiveTitle || '';
  if (
    GLOBAL_INTERRUPT_KEYWORDS.test(text.trim()) &&
    session.state !== STATES.LANGUAGE_SELECTION
  ) {
    await routeFromIntent(ctx);
    await touchSession(session);
    return;
  }

  const handler = STATE_HANDLERS[session.state];
  if (!handler) {
    logger.warn({ state: session.state }, '[stateMachine] no handler for state — resetting to main menu');
    const { transition } = require('./sessionManager');
    await transition(session, session.language ? STATES.MAIN_MENU : STATES.LANGUAGE_SELECTION);
    if (session.language) await renderMainMenu(ctx);
    else await promptLanguageSelection(ctx);
    await touchSession(session);
    return;
  }

  try {
    await handler(ctx);
  } catch (err) {
    logger.error({ err: err.message, state: session.state }, '[stateMachine] handler threw');
    await send.text('generic_error');
    const { escalateToHuman } = require('./handlers/handoff.handler');
    await escalateToHuman(ctx, 'UNHANDLED_ERROR', { message: err.message });
  }

  await touchSession(session);
}

module.exports = { processInboundMessage, STATE_HANDLERS };
