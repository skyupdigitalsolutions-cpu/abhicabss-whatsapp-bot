const { STATES } = require('../states');
const { transition } = require('../sessionManager');
const { t } = require('../../utils/i18n');
const dateParser = require('../nlu/dateParser');
const locationParser = require('../nlu/locationParser');
const { callTool } = require('../../integrations/ai/tools');
const { logger } = require('../../config/logger');
const { toNumbered, rememberOptions } = require('../numberedMenu');

const TRIP_TYPES = [
  { id: 'TRIP_ONE_WAY', value: 'ONE_WAY', key: 'trip_one_way', number: 1 },
  { id: 'TRIP_ROUND_TRIP', value: 'ROUND_TRIP', key: 'trip_round_trip', number: 2 },
  { id: 'TRIP_AIRPORT', value: 'AIRPORT', key: 'trip_airport', number: 3 },
  { id: 'TRIP_HOURLY', value: 'HOURLY', key: 'trip_hourly', number: 4 },
];

// ── STEP 1: Trip type ──────────────────────────────────────────────

async function promptTripType(ctx) {
  const items = TRIP_TYPES.map((tt) => ({ id: tt.id, number: tt.number, label: t(ctx.language, tt.key) }));
  const { rows, map } = toNumbered(items);
  await ctx.send.list('ask_trip_type', 'ask_trip_type', [{ title: 'Trip Type', rows }]);
  await rememberOptions(ctx.session, map);
}

async function handleBookingTripType(ctx) {
  const { message, session } = ctx;
  const picked = TRIP_TYPES.find((tt) => tt.id === message.interactiveId);

  if (!picked) {
    // Allow free text like "one way" / natural language via nluRouter's entity hint.
    const guess = TRIP_TYPES.find((tt) => (message.text || '').toLowerCase().includes(tt.value.toLowerCase().replace('_', ' ')));
    if (!guess) {
      await ctx.send.text('ask_trip_type');
      await promptTripType(ctx);
      return;
    }
    session.draft.tripType = guess.value;
  } else {
    session.draft.tripType = picked.value;
  }

  await session.save();
  await transition(session, STATES.BOOKING_PICKUP);
  await ctx.send.text('ask_pickup');
}

// ── STEP 2: Pickup ──────────────────────────────────────────────────

async function handleBookingPickup(ctx) {
  const { message, session } = ctx;

  let location;
  if (message.location) {
    location = locationParser.fromWhatsAppLocationMessage(message.location);
  } else if (message.text) {
    location = locationParser.fromTypedText(message.text);
  } else {
    await ctx.send.text('ask_pickup');
    return;
  }

  if (locationParser.isAmbiguous(location.address)) {
    await ctx.send.text('location_ambiguous');
    return;
  }

  session.draft.pickup = location;
  await session.save();

  if (session.draft.tripType === 'HOURLY') {
    await transition(session, STATES.BOOKING_DATE);
    await ctx.send.text('ask_date');
  } else {
    await transition(session, STATES.BOOKING_DROP);
    await ctx.send.text('ask_drop');
  }
}

// ── STEP 3: Drop (skipped for HOURLY) ───────────────────────────────

async function handleBookingDrop(ctx) {
  const { message, session } = ctx;

  let location;
  if (message.location) {
    location = locationParser.fromWhatsAppLocationMessage(message.location);
  } else if (message.text) {
    location = locationParser.fromTypedText(message.text);
  } else {
    await ctx.send.text('ask_drop');
    return;
  }

  if (locationParser.isAmbiguous(location.address)) {
    await ctx.send.text('location_ambiguous');
    return;
  }

  session.draft.drop = location;
  await session.save();
  await transition(session, STATES.BOOKING_DATE);
  await ctx.send.text('ask_date');
}

// ── STEP 4: Date ─────────────────────────────────────────────────────

async function handleBookingDate(ctx) {
  const { message, session } = ctx;
  const resolved = dateParser.resolveDatePhrase(message.text || message.interactiveTitle);

  if (!resolved) {
    await ctx.send.text('ask_date');
    return;
  }

  session.draft._pendingDate = resolved.toISOString(); // temp holder until time is combined
  await session.save();
  await transition(session, STATES.BOOKING_TIME);
  await ctx.send.text('ask_time');
}

// ── STEP 5: Time ─────────────────────────────────────────────────────

async function handleBookingTime(ctx) {
  const { message, session } = ctx;
  const time = dateParser.resolveTimePhrase(message.text || message.interactiveTitle);

  if (!time) {
    await ctx.send.text('ask_time');
    return;
  }

  const dayjsDate = require('dayjs').tz(session.draft._pendingDate, dateParser.TZ);
  const combined = dateParser.combineDateTime(dayjsDate, time);

  if (dateParser.isPast(combined)) {
    await ctx.send.raw(t(ctx.language, 'ask_date')); // ask again — cannot book in the past
    await transition(session, STATES.BOOKING_DATE);
    return;
  }

  session.draft.pickupAt = combined.toDate();
  await session.save();

  if (session.draft.tripType === 'ROUND_TRIP') {
    await transition(session, STATES.BOOKING_RETURN_DATE);
    await ctx.send.text('ask_return_date');
    return;
  }
  if (session.draft.tripType === 'HOURLY') {
    await transition(session, STATES.BOOKING_RENTAL_HOURS);
    await ctx.send.text('ask_rental_hours');
    return;
  }

  await proceedToPassengers(ctx);
}

// ── STEP 5b: Round trip return date/time ────────────────────────────

async function handleBookingReturnDate(ctx) {
  const { message, session } = ctx;
  const resolved = dateParser.resolveDatePhrase(message.text || message.interactiveTitle);
  if (!resolved) {
    await ctx.send.text('ask_return_date');
    return;
  }
  session.draft._pendingReturnDate = resolved.toISOString();
  await session.save();
  await transition(session, STATES.BOOKING_RETURN_TIME);
  await ctx.send.text('ask_return_time');
}

async function handleBookingReturnTime(ctx) {
  const { message, session } = ctx;
  const time = dateParser.resolveTimePhrase(message.text || message.interactiveTitle);
  if (!time) {
    await ctx.send.text('ask_return_time');
    return;
  }
  const dayjsDate = require('dayjs').tz(session.draft._pendingReturnDate, dateParser.TZ);
  const combined = dateParser.combineDateTime(dayjsDate, time);

  if (combined.isBefore(dayjsDate.tz ? require('dayjs')(session.draft.pickupAt) : null)) {
    // return before pickup — ask again
    await ctx.send.text('ask_return_date');
    await transition(session, STATES.BOOKING_RETURN_DATE);
    return;
  }

  session.draft.returnAt = combined.toDate();
  await session.save();
  await proceedToPassengers(ctx);
}

// ── STEP 5c: Hourly rental package ──────────────────────────────────

async function handleBookingRentalHours(ctx) {
  const { message, session } = ctx;
  const hoursMatch = (message.text || message.interactiveTitle || '').match(/\d+/);
  if (!hoursMatch) {
    await ctx.send.text('ask_rental_hours');
    return;
  }
  session.draft.rentalHours = parseInt(hoursMatch[0], 10);
  await session.save();
  await proceedToPassengers(ctx);
}

// ── STEP 6: Passenger count ─────────────────────────────────────────

async function proceedToPassengers(ctx) {
  const { session } = ctx;
  await transition(session, STATES.BOOKING_PASSENGERS);
  await ctx.send.text('ask_passenger_count');
}

async function handleBookingPassengers(ctx) {
  const { message, session } = ctx;
  const countMatch = (message.text || message.interactiveTitle || '').match(/\d+/);
  if (!countMatch) {
    await ctx.send.text('ask_passenger_count');
    return;
  }
  session.draft.passengerCount = parseInt(countMatch[0], 10);
  await session.save();
  await showVehicleOptions(ctx);
}

// ── STEP 7: Vehicle options (backend fare API — never invented) ────

async function showVehicleOptions(ctx) {
  const { session } = ctx;
  await ctx.send.text('checking_vehicles');

  let options;
  try {
    options = await callTool('getFareOptions', {
      tripType: session.draft.tripType,
      pickup: session.draft.pickup,
      drop: session.draft.drop,
      pickupAt: session.draft.pickupAt,
      returnAt: session.draft.returnAt,
      rentalHours: session.draft.rentalHours,
    });
  } catch (err) {
    logger.error({ err: err.message }, '[booking] getFareOptions failed');
    await ctx.send.text('fare_api_failed');
    return;
  }

  if (!options || options.length === 0) {
    await ctx.send.text('no_vehicles_available');
    const { escalateToHuman } = require('./handoff.handler');
    await escalateToHuman(ctx, 'NO_VEHICLES_AVAILABLE', { category: 'BOOKING_ISSUE' });
    return;
  }

  session._cachedOptions = options; // not persisted — see BOOKING_VEHICLE_SELECTION handler note
  session.markModified('draft');
  await session.save();

  // Persist minimal option data on the session doc so selection survives
  // a process restart (in-memory _cachedOptions would not).
  session.draft._vehicleOptions = options.map((o) => ({
    vehicleId: o.vehicleId,
    vehicleName: o.vehicleName,
    category: o.category,
    seatingCapacity: o.seatingCapacity,
    ac: o.ac,
    fareQuoteId: o.fareQuoteId,
    fare: o.fare,
  }));
  await session.save();

  const rows = options.map((o, i) => ({
    id: `VEHICLE_${o.vehicleId}`,
    number: i + 1,
    label: `${o.vehicleName}`.slice(0, 22),
    description: `${o.seatingCapacity} seats · ₹${o.fare.total}`,
  }));
  const { rows: numberedRows, map } = toNumbered(rows);

  await transition(session, STATES.BOOKING_VEHICLE_SELECTION);
  await ctx.send.list('select_vehicle', 'select_vehicle', [{ title: 'Vehicles', rows: numberedRows }]);
  await rememberOptions(session, map);
}

async function handleBookingVehicleSelection(ctx) {
  const { message, session } = ctx;
  const vehicleId = (message.interactiveId || '').replace(/^VEHICLE_/, '');
  const option = (session.draft._vehicleOptions || []).find((o) => o.vehicleId === vehicleId);

  if (!option) {
    await ctx.send.text('select_vehicle');
    return;
  }

  session.draft.vehicleId = option.vehicleId;
  session.draft.vehicleClass = option.category;
  session.draft.fareQuoteId = option.fareQuoteId;
  session.draft.fare = option.fare;
  await session.save();

  await showFareConfirmation(ctx, option);
}

async function showFareConfirmation(ctx, option) {
  const { session } = ctx;
  const f = option.fare;
  const body =
    `${t(ctx.language, 'fare_estimate_title')}\n\n` +
    `Vehicle: ${option.vehicleName}\n` +
    `Base Fare: ₹${f.baseFare}\n` +
    (f.driverAllowance ? `Driver Allowance: ₹${f.driverAllowance}\n` : '') +
    (f.surge ? `Surge: ₹${f.surge}\n` : '') +
    `Tax: ₹${f.tax}\n\n` +
    `Total: ₹${f.total}`;

  await transition(session, STATES.BOOKING_FARE_CONFIRMATION);

  if (ctx.fareOnly) {
    await ctx.send.raw(body);
    const { renderMainMenu } = require('./mainMenu.handler');
    await transition(session, STATES.MAIN_MENU);
    await renderMainMenu(ctx);
    return;
  }

  const buttons = [
    { id: 'FARE_CONTINUE', number: 1, label: t(ctx.language, 'continue_booking') },
    { id: 'FARE_CHANGE_VEHICLE', number: 2, label: t(ctx.language, 'change_vehicle') },
    { id: 'FARE_MODIFY_TRIP', number: 3, label: t(ctx.language, 'modify_trip') },
  ];
  const { rows: numberedButtons, map } = toNumbered(
    buttons.map((b) => ({ ...b, maxTitleLength: 20 }))
  );

  await ctx.send.buttonsRaw(
    body,
    numberedButtons.map((b) => ({ id: b.id, title: b.title }))
  );
  await rememberOptions(session, map);
}

async function handleBookingFareConfirmation(ctx) {
  const { message, session } = ctx;

  if (message.interactiveId === 'FARE_CHANGE_VEHICLE') {
    await showVehicleOptions(ctx);
    return;
  }
  if (message.interactiveId === 'FARE_MODIFY_TRIP') {
    session.resetDraft();
    await transition(session, STATES.BOOKING_TRIP_TYPE);
    await promptTripType(ctx);
    return;
  }

  // Default / FARE_CONTINUE
  await transition(session, STATES.BOOKING_CUSTOMER_NAME);
  await ctx.send.text('ask_name');
}

module.exports = {
  promptTripType,
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
};
