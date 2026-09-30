const { INTENTS, ruleBasedIntent } = require('../../integrations/ai/intentExtractor');
const { STATES } = require('../states');
const { transition } = require('../sessionManager');

/**
 * Used both at MAIN_MENU (customer typed instead of tapping a button)
 * and mid-flow (spec section 40 — "interruption handling"). Each
 * branch hands off to the right handler/state rather than trying to
 * resolve everything inline here.
 */
async function routeFromIntent(ctx) {
  const { message, session } = ctx;
  const text = message.text || message.interactiveTitle || '';
  const intent = ruleBasedIntent(text);

  switch (intent) {
    case INTENTS.GREETING: {
      const { renderMainMenu } = require('./mainMenu.handler');
      await renderMainMenu(ctx);
      return;
    }
    case INTENTS.BOOK_CAB: {
      const { promptTripType } = require('./booking.handler');
      session.resetDraft();
      await transition(session, STATES.BOOKING_TRIP_TYPE);
      await promptTripType(ctx);
      return;
    }
    case INTENTS.FARE_ENQUIRY: {
      const { promptTripType } = require('./booking.handler');
      session.resetDraft();
      await transition(session, STATES.BOOKING_TRIP_TYPE);
      await promptTripType({ ...ctx, fareOnly: true });
      return;
    }
    case INTENTS.MY_BOOKINGS: {
      const { showMyBookings } = require('./myBookings.handler');
      await transition(session, STATES.MY_BOOKINGS);
      await showMyBookings(ctx);
      return;
    }
    case INTENTS.TRACK_BOOKING: {
      const { promptBookingForTracking } = require('./tracking.handler');
      await promptBookingForTracking(ctx);
      return;
    }
    case INTENTS.CANCEL_BOOKING: {
      const { promptBookingForCancellation } = require('./cancellation.handler');
      await promptBookingForCancellation(ctx);
      return;
    }
    case INTENTS.INVOICE_REQUEST: {
      const { promptBookingForInvoice } = require('./myBookings.handler');
      await promptBookingForInvoice(ctx);
      return;
    }
    case INTENTS.PAYMENT_STATUS_QUERY: {
      const { handlePaymentStatusQuery } = require('./payment.handler');
      await handlePaymentStatusQuery(ctx);
      return;
    }
    case INTENTS.SUPPORT_REQUEST: {
      const { promptSupportCategory } = require('./support.handler');
      await transition(session, STATES.SUPPORT_CATEGORY);
      await promptSupportCategory(ctx);
      return;
    }
    case INTENTS.HUMAN_REQUEST: {
      const { escalateToHuman } = require('./handoff.handler');
      await escalateToHuman(ctx, 'CUSTOMER_REQUESTED_HUMAN');
      return;
    }
    default: {
      const { renderMainMenu } = require('./mainMenu.handler');
      await ctx.send.text('generic_error');
      await renderMainMenu(ctx);
    }
  }
}

module.exports = { routeFromIntent };
