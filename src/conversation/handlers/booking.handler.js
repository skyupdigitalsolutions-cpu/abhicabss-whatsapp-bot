const dayjs = require('dayjs');
const { STATES } = require('../states');
const { transition } = require('../sessionManager');
const { t } = require('../../utils/i18n');
const dateParser = require('../nlu/dateParser');
const locationParser = require('../nlu/locationParser');
const { callTool } = require('../../integrations/ai/tools');
const { logger } = require('../../config/logger');
const { toNumbered, rememberOptions } = require('../numberedMenu');
const { inr } = require('../../utils/format');

const TRIP_TYPES = [
  { id: 'TRIP_ONE_WAY', value: 'ONE_WAY', key: 'trip_one_way', number: 1 },
  { id: 'TRIP_ROUND_TRIP', value: 'ROUND_TRIP', key: 'trip_round_trip', number: 2 },
  { id: 'TRIP_AIRPORT', value: 'AIRPORT', key: 'trip_airport', number: 3 },
  { id: 'TRIP_HOURLY', value: 'HOURLY', key: 'trip_hourly', number: 4 },
];

/**
 * Like t(), but returns `fallback` when the key is missing in the customer's
 * language file, so a language that has not been updated yet never shows a raw key.
 */
function tOr(language, key, fallback) {
  try {
    const v = t(language, key);
    if (!v || typeof v !== 'string' || v.includes(key)) return fallback;
    return v;
  } catch (e) {
    return fallback;
  }
}

/**
 * "Book a Cab": a new one-way booking that starts straight at the pickup question.
 * (The trip-type question was removed from the flow.)
 */
async function startBooking(ctx) {
  const { session } = ctx;
  session.resetDraft();
  session.draft.tripType = 'ONE_WAY';
  await session.save();
  await transition(session, STATES.BOOKING_PICKUP);
  await ctx.send.text('ask_pickup');
}

// ── STEP 1: Trip type ──────────────────────────────────────────────

async function promptTripType(ctx) {
  const items = TRIP_TYPES.map((tt) => ({ id: tt.id, number: tt.number, label: t(ctx.language, tt.key) }));
  const { rows, map } = toNumbered(items);
  // The list button needs a SHORT label (max 20 chars). It used to reuse the
  // question text, which got cut off as "What type of trip do".
  await ctx.send.listRaw(
    t(ctx.language, 'ask_trip_type'),
    tOr(ctx.language, 'btn_select_trip', 'Select Trip'),
    [{ title: 'Trip Type', rows }]
  );
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
    await promptDate(ctx);
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
  await promptDate(ctx);
}

// ── STEP 4: Date (calendar list) ────────────────────────────────────

/**
 * Sends the calendar: a tap-to-select WhatsApp list with Today, Tomorrow, the
 * following days, and an "Another date" row for anything else.
 * For the return date of a round trip, the list starts from the pickup day.
 */
async function promptDate(ctx, { returnTrip = false } = {}) {
  const { language, session } = ctx;
  const labels = {
    today: tOr(language, 'date_today', 'Today'),
    tomorrow: tOr(language, 'date_tomorrow', 'Tomorrow'),
    another: tOr(language, 'date_another', 'Another date'),
    anotherHint: tOr(language, 'date_another_hint', 'Type it, e.g. 25 October'),
  };
  const from = returnTrip && session.draft.pickupAt ? session.draft.pickupAt : undefined;
  const rows = dateParser.getDateListRows({ from, labels });

  await ctx.send.listRaw(
    t(language, returnTrip ? 'ask_return_date' : 'ask_date'),
    tOr(language, 'date_pick_button', 'Pick a date'),
    [{ title: tOr(language, 'date_section_title', 'Dates'), rows }]
  );
}

/**
 * Reads the customer's date answer, whether they tapped a calendar row or typed.
 * Returns { resolved } (a dayjs date), { other: true } when they tapped
 * "Another date", or {} when it could not be understood.
 */
function readDateAnswer(message) {
  const title = message.text || message.interactiveTitle || '';

  if (message.interactiveId === 'DATE_OTHER' || /^another date/i.test(title.trim())) {
    return { other: true };
  }

  const tapped = dateParser.parseDateReply(message.interactiveId);
  const resolved = dateParser.resolveDatePhrase(tapped || title);
  return resolved ? { resolved } : {};
}

async function handleBookingDate(ctx) {
  const { message, session } = ctx;
  const answer = readDateAnswer(message);

  if (answer.other) {
    await ctx.send.raw(
      tOr(ctx.language, 'ask_date_typed', '📅 Please type the travel date, for example 25 October or 25/10.')
    );
    return;
  }

  if (!answer.resolved) {
    await promptDate(ctx);
    return;
  }

  if (answer.resolved.isBefore(dateParser.now().startOf('day'))) {
    await ctx.send.raw(tOr(ctx.language, 'date_in_past', 'That date has already passed. Please choose a date from today onwards.'));
    await promptDate(ctx);
    return;
  }

  session.draft._pendingDate = answer.resolved.toISOString(); // temp holder until time is combined
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

  // _pendingDate is an ISO instant. Parse it as an instant and convert to India
  // time. (dayjs.tz(iso, TZ) reads the clock digits as India time instead, which
  // moved every booking one day earlier.)
  const dayjsDate = dayjs(session.draft._pendingDate).tz(dateParser.TZ);
  const combined = dateParser.combineDateTime(dayjsDate, time);

  if (dateParser.isPast(combined)) {
    await ctx.send.raw(tOr(ctx.language, 'time_in_past', 'That time has already passed. Please choose a later date or time.'));
    await transition(session, STATES.BOOKING_DATE);
    await promptDate(ctx);
    return;
  }

  session.draft.pickupAt = combined.toDate();
  await session.save();

  if (session.draft.tripType === 'ROUND_TRIP') {
    await transition(session, STATES.BOOKING_RETURN_DATE);
    await promptDate(ctx, { returnTrip: true });
    return;
  }
  if (session.draft.tripType === 'HOURLY') {
    await transition(session, STATES.BOOKING_RENTAL_HOURS);
    await ctx.send.text('ask_rental_hours');
    return;
  }

  await showVehicleOptions(ctx);
}

// ── STEP 5b: Round trip return date/time ────────────────────────────

async function handleBookingReturnDate(ctx) {
  const { message, session } = ctx;
  const answer = readDateAnswer(message);

  if (answer.other) {
    await ctx.send.raw(
      tOr(ctx.language, 'ask_date_typed', '📅 Please type the travel date, for example 25 October or 25/10.')
    );
    return;
  }

  if (!answer.resolved) {
    await promptDate(ctx, { returnTrip: true });
    return;
  }

  const pickupDay = session.draft.pickupAt ? dayjs(session.draft.pickupAt).tz(dateParser.TZ).startOf('day') : null;
  if (answer.resolved.isBefore(dateParser.now().startOf('day')) || (pickupDay && answer.resolved.isBefore(pickupDay))) {
    await ctx.send.raw(tOr(ctx.language, 'return_before_pickup', 'The return date cannot be before your pickup date. Please choose again.'));
    await promptDate(ctx, { returnTrip: true });
    return;
  }

  session.draft._pendingReturnDate = answer.resolved.toISOString();
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
  const dayjsDate = dayjs(session.draft._pendingReturnDate).tz(dateParser.TZ);
  const combined = dateParser.combineDateTime(dayjsDate, time);

  if (combined.isBefore(dayjs(session.draft.pickupAt))) {
    // return before pickup — ask again
    await ctx.send.raw(tOr(ctx.language, 'return_before_pickup', 'The return date cannot be before your pickup date. Please choose again.'));
    await transition(session, STATES.BOOKING_RETURN_DATE);
    await promptDate(ctx, { returnTrip: true });
    return;
  }

  session.draft.returnAt = combined.toDate();
  await session.save();
  await showVehicleOptions(ctx);
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
  await showVehicleOptions(ctx);
}

// ── STEP 6: Cab type (fares come from the fare engine — never invented) ────

const MAX_LIST_ROWS = 10; // WhatsApp allows at most 10 rows in one list
const CATEGORY_ORDER = ['SEDAN', 'SUV', 'PREMIUM', 'LUXURY', 'TEMPO_TRAVELLER', 'BUS'];

/** Adds the numbered choices to the message text, so a customer can simply reply "1". */
function withChoices(language, body, rows) {
  const lines = rows.map((r) => `${r.title}${r.description ? ` — ${r.description}` : ''}`);
  const hint = tOr(language, 'reply_number_hint', 'Reply with the number (for example 1), or tap the button below.');
  return `${body}\n\n${lines.join('\n')}\n\n${hint}`.slice(0, 1000);
}

const titleCase = (s) =>
  String(s).toLowerCase().split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/**
 * Fetches priced cab options for this trip and shows them.
 * minSeats: only offer cabs that seat at least this many (used when the passenger
 * count turned out to be more than the chosen cab holds).
 */
async function showVehicleOptions(ctx, { minSeats = 0 } = {}) {
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

  options = (options || []).filter((o) => o.seatingCapacity >= minSeats);

  if (options.length === 0) {
    await ctx.send.text('no_vehicles_available');
    const { escalateToHuman } = require('./handoff.handler');
    await escalateToHuman(ctx, 'NO_VEHICLES_AVAILABLE', { category: 'BOOKING_ISSUE' });
    return;
  }

  options.sort((a, b) => a.fare.total - b.fare.total);

  // Persist minimal option data on the session so the selection survives a restart.
  session.draft._vehicleOptions = options.map((o) => ({
    vehicleId: o.vehicleId,
    vehicleName: o.vehicleName,
    category: o.category,
    seatingCapacity: o.seatingCapacity,
    ac: o.ac,
    fareQuoteId: o.fareQuoteId,
    fare: o.fare,
  }));
  session.draft._vehicleCategory = null;
  session.draft.vehicleId = null;
  session.markModified('draft');

  await transition(session, STATES.BOOKING_VEHICLE_SELECTION);
  await sendVehicleChoices(ctx);
}

/**
 * Shows either the cab list, or — when there are more than 10 cabs, which WhatsApp
 * cannot fit in one list — a short "Cab Type" list (Sedan, SUV, Tempo Traveller...)
 * followed by the cabs of the chosen type.
 */
async function sendVehicleChoices(ctx) {
  const { session, language } = ctx;
  const all = session.draft._vehicleOptions || [];
  const category = session.draft._vehicleCategory;

  if (!category && all.length > MAX_LIST_ROWS) {
    const groups = new Map();
    for (const o of all) {
      if (!groups.has(o.category)) groups.set(o.category, []);
      groups.get(o.category).push(o);
    }
    const rank = (c) => (CATEGORY_ORDER.indexOf(c) === -1 ? 99 : CATEGORY_ORDER.indexOf(c));
    const categories = [...groups.keys()].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_LIST_ROWS);

    const rows = categories.map((c, i) => {
      const g = groups.get(c);
      const from = Math.min(...g.map((o) => o.fare.total));
      return {
        id: `CAT_${c}`,
        number: i + 1,
        label: tOr(language, `cab_category_${c}`, titleCase(c)),
        description: `${g.length} option${g.length > 1 ? 's' : ''} · from ${inr(from)}`,
      };
    });
    const { rows: numbered, map } = toNumbered(rows);
    await ctx.send.listRaw(
      withChoices(language, t(language, 'ask_cab_type'), numbered),
      tOr(language, 'btn_select_cab_type', 'Select Cab Type'),
      [{ title: 'Cab types', rows: numbered }]
    );
    await rememberOptions(session, map);
    return;
  }

  const pool = (category ? all.filter((o) => o.category === category) : all).slice(0, MAX_LIST_ROWS);
  const rows = pool.map((o, i) => ({
    id: `VEHICLE_${o.vehicleId}`,
    number: i + 1,
    label: `${o.vehicleName}`.slice(0, 22),
    // Title already shows the name, so the description only needs seats and fare.
    description: `${o.seatingCapacity} seats · ${inr(o.fare.total)}`,
  }));
  const { rows: numbered, map } = toNumbered(rows);
  await ctx.send.listRaw(
    withChoices(language, t(language, 'select_vehicle'), numbered),
    tOr(language, 'btn_select_vehicle', 'Select Vehicle'),
    [{ title: 'Vehicles', rows: numbered }]
  );
  await rememberOptions(session, map);
}

async function chooseVehicle(ctx, option) {
  const { session } = ctx;
  session.draft.vehicleId = option.vehicleId;
  session.draft.vehicleName = option.vehicleName;
  session.draft.vehicleClass = option.category;
  session.draft.fareQuoteId = option.fareQuoteId;
  session.draft.fare = option.fare;
  session.markModified('draft');
  await session.save();

  // Came back here because the group was bigger than the cab? Details are already known.
  if (session.draft.passengerName && session.draft.passengerCount) {
    const { showBookingReview } = require('./bookingReview.handler');
    await showBookingReview(ctx);
    return;
  }

  await transition(session, STATES.BOOKING_CUSTOMER_NAME);
  await ctx.send.text('ask_name');
}

/** Lower-case text with any leading "1️⃣" / "2." numbering removed, for matching against names. */
const plainChoice = (text) =>
  String(text || '').toLowerCase().replace(/^\s*\d{1,2}(?:\uFE0F?\u20E3|[.)])?\s*/, '').trim();

async function handleBookingVehicleSelection(ctx) {
  const { message, session, language } = ctx;
  let id = message.interactiveId || '';
  const all = session.draft._vehicleOptions || [];

  // No hidden id (only the tapped text arrived)? Work out which cab type / cab was meant by its name.
  if (!id) {
    const said = plainChoice(message.text || message.interactiveTitle);
    if (said.length >= 3) {
      const inCategoryMode = !session.draft._vehicleCategory && all.length > MAX_LIST_ROWS;
      if (inCategoryMode) {
        const cats = [...new Set(all.map((o) => o.category))];
        const hit = cats.find((c) => {
          const label = String(tOr(language, `cab_category_${c}`, titleCase(c))).toLowerCase();
          return said.startsWith(label) || label.startsWith(said);
        });
        if (hit) id = `CAT_${hit}`;
      } else {
        const pool = session.draft._vehicleCategory ? all.filter((o) => o.category === session.draft._vehicleCategory) : all;
        const hit = pool.find((o) => {
          const name = o.vehicleName.toLowerCase();
          return said.startsWith(name.slice(0, 22)) || name.startsWith(said.slice(0, 22)) || said.includes(name);
        });
        if (hit) id = `VEHICLE_${hit.vehicleId}`;
      }
    }
  }

  // Tapped a cab type (Sedan / SUV / ...)
  if (id.startsWith('CAT_')) {
    const category = id.slice(4);
    const inCategory = all.filter((o) => o.category === category);
    if (inCategory.length === 1) {
      await chooseVehicle(ctx, inCategory[0]); // only one cab of this type: no need to ask again
      return;
    }
    if (inCategory.length > 1) {
      session.draft._vehicleCategory = category;
      session.markModified('draft');
      await session.save();
      await sendVehicleChoices(ctx);
      return;
    }
  }

  const vehicleId = id.replace(/^VEHICLE_/, '');
  const option = all.find((o) => o.vehicleId === vehicleId);
  if (!option) {
    await sendVehicleChoices(ctx);
    return;
  }

  await chooseVehicle(ctx, option);
}

// ── STEP 7: Passenger details (name is asked in bookingReview.handler, then the count here) ──

async function handleBookingPassengers(ctx) {
  const { message, session } = ctx;
  const countMatch = (message.text || message.interactiveTitle || '').match(/\d+/);
  const count = countMatch ? parseInt(countMatch[0], 10) : 0;
  if (!count || count > 60) {
    await ctx.send.text('ask_passenger_count');
    return;
  }

  session.draft.passengerCount = count;
  await session.save();

  const chosen = (session.draft._vehicleOptions || []).find((o) => o.vehicleId === session.draft.vehicleId);
  if (chosen && count > chosen.seatingCapacity) {
    await ctx.send.text('passenger_exceeds', { cab: chosen.vehicleName, seats: chosen.seatingCapacity });
    await showVehicleOptions(ctx, { minSeats: count });
    return;
  }

  const { showBookingReview } = require('./bookingReview.handler');
  await showBookingReview(ctx);
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
  startBooking,
  promptTripType,
  promptDate,
  showVehicleOptions,
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
