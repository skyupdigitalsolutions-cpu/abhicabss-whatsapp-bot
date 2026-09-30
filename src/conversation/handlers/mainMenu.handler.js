const { STATES } = require('../states');
const { transition } = require('../sessionManager');
const { t } = require('../../utils/i18n');
const { makeSender } = require('../outbound');
const { toNumbered, rememberOptions } = require('../numberedMenu');

// number intentionally skips 7 (reserved for a future "Offers" menu item,
// matching the numbering the customer sees in the original spec).
const MENU_ITEMS = [
  { id: 'MENU_BOOK_CAB', number: 1, titleKey: 'menu_book_cab' },
  { id: 'MENU_FARE_ESTIMATE', number: 2, titleKey: 'menu_fare_estimate' },
  { id: 'MENU_MY_BOOKING', number: 3, titleKey: 'menu_my_booking' },
  { id: 'MENU_TRACK_BOOKING', number: 4, titleKey: 'menu_track_booking' },
  { id: 'MENU_CANCEL_BOOKING', number: 5, titleKey: 'menu_cancel_booking' },
  { id: 'MENU_INVOICE', number: 6, titleKey: 'menu_invoice' },
  { id: 'MENU_SUPPORT', number: 8, titleKey: 'menu_support' },
  { id: 'MENU_CHANGE_LANGUAGE', number: 9, titleKey: 'menu_change_language' },
];

async function renderMainMenu(ctx) {
  const send = ctx.send || makeSender(ctx.session.whatsappNumber, ctx.language);
  const items = MENU_ITEMS.map((m) => ({ id: m.id, number: m.number, label: t(ctx.language, m.titleKey) }));
  const { rows, map } = toNumbered(items);

  await send.list('main_menu_greeting', 'menu_book_cab', [{ title: 'Menu', rows }]);
  await rememberOptions(ctx.session, map);
}

async function handleMainMenu(ctx) {
  const { message, session } = ctx;
  const id = message.interactiveId;

  const routes = {
    MENU_BOOK_CAB: async () => {
      const { promptTripType } = require('./booking.handler');
      session.resetDraft();
      await transition(session, STATES.BOOKING_TRIP_TYPE);
      await promptTripType(ctx);
    },
    MENU_FARE_ESTIMATE: async () => {
      const { promptTripType } = require('./booking.handler');
      session.resetDraft();
      await transition(session, STATES.BOOKING_TRIP_TYPE);
      await promptTripType({ ...ctx, fareOnly: true });
    },
    MENU_MY_BOOKING: async () => {
      const { showMyBookings } = require('./myBookings.handler');
      await transition(session, STATES.MY_BOOKINGS);
      await showMyBookings(ctx);
    },
    MENU_TRACK_BOOKING: async () => {
      const { promptBookingForTracking } = require('./tracking.handler');
      await promptBookingForTracking(ctx);
    },
    MENU_CANCEL_BOOKING: async () => {
      const { promptBookingForCancellation } = require('./cancellation.handler');
      await promptBookingForCancellation(ctx);
    },
    MENU_INVOICE: async () => {
      const { promptBookingForInvoice } = require('./myBookings.handler');
      await promptBookingForInvoice(ctx);
    },
    MENU_SUPPORT: async () => {
      const { promptSupportCategory } = require('./support.handler');
      await transition(session, STATES.SUPPORT_CATEGORY);
      await promptSupportCategory(ctx);
    },
    MENU_CHANGE_LANGUAGE: async () => {
      const { promptLanguageSelection } = require('./language.handler');
      await transition(session, STATES.LANGUAGE_SELECTION);
      await promptLanguageSelection(ctx);
    },
  };

  if (id && routes[id]) {
    await routes[id]();
    return;
  }

  // Free text fallback — let NLU intent decide.
  await require('./nluRouter').routeFromIntent(ctx);
}

module.exports = { renderMainMenu, handleMainMenu, MENU_ITEMS };
