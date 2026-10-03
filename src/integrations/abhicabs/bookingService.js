const crypto = require('crypto');
const env = require('../../config/env');
const { getPrisma } = require('../../config/db');
const backendHttp = require('./backendHttp');
const { estimateFare } = require('./fareService');

/** 6-digit numeric suffix for booking numbers, e.g. ABHI384021. */
function genDigits() {
  return crypto.randomInt(100000, 999999).toString();
}

/** Adds a Mongoose-style `_id` alias so existing handler code (booking._id) keeps working unchanged. */
function withId(row) {
  return row ? { ...row, _id: row.id } : row;
}

/** True when a Prisma error is a unique-constraint violation (Postgres equivalent of Mongo's code 11000). */
function isUniqueConstraintError(err) {
  return err?.code === 'P2002';
}

async function generateBookingNumber() {
  const prisma = getPrisma();
  for (let i = 0; i < 5; i++) {
    const candidate = `ABHI${genDigits()}`;
    // eslint-disable-next-line no-await-in-loop
    const exists = await prisma.botBooking.findUnique({ where: { bookingNumber: candidate } });
    if (!exists) return candidate;
  }
  throw new Error('BOOKING_NUMBER_GENERATION_FAILED');
}

/**
 * createBooking Ã¢â‚¬â€ the ONLY way a booking is ever created. Enforces:
 *   1. idempotencyKey uniqueness (duplicate WhatsApp message / webhook
 *      retry / double button tap returns the EXISTING booking instead
 *      of creating a second one).
 *   2. Fare re-verification against the backend fare engine right
 *      before persisting Ã¢â‚¬â€ the AI-relayed price is never trusted blindly.
 */
async function createBooking({ idempotencyKey, customerId, passenger, customerType, companyName, gstNumber, tripType, pickup, drop, pickupAt, returnAt, rentalHours, vehicleId, fareQuoteId, specialRequests }) {
  const prisma = getPrisma();

  const existing = await prisma.botBooking.findUnique({ where: { idempotencyKey } });
  if (existing) return { booking: withId(existing), created: false };

  if (env.BACKEND_MODE === 'remote') {
    const { data } = await backendHttp.post(
      '/bookings',
      {
        customerId, passenger, customerType, companyName, gstNumber,
        tripType, pickup, drop, pickupAt, returnAt, rentalHours,
        vehicleId, fareQuoteId, specialRequests,
      },
      { headers: { 'Idempotency-Key': idempotencyKey } }
    );
    // The remote backend is expected to also honor Idempotency-Key.
    // Mirror the record locally for the bot's own session/lookup needs.
    const mirrored = await prisma.botBooking.create({ data: { ...data, idempotencyKey } });
    return { booking: withId(mirrored), created: true };
  }

  const fare = await estimateFare({ fareQuoteId, tripType, pickup, drop, pickupAt, returnAt, rentalHours, vehicleId });
  const bookingNumber = await generateBookingNumber();

  try {
    const booking = await prisma.botBooking.create({
      data: {
        bookingNumber,
        channel: 'WHATSAPP',
        customerId,
        passenger,
        customerType,
        companyName,
        gstNumber,
        tripType,
        pickup,
        drop: drop || undefined,
        pickupAt: new Date(pickupAt),
        returnAt: returnAt ? new Date(returnAt) : null,
        rentalHours,
        vehicle: { vehicleId: fare.vehicleId, name: fare.vehicleName, category: fare.category },
        fare: fare.fare,
        status: 'CREATED',
        specialRequests,
        idempotencyKey,
      },
    });
    return { booking: withId(booking), created: true };
  } catch (err) {
    // Race condition: two near-simultaneous requests with the same key.
    if (isUniqueConstraintError(err) && err.meta?.target?.includes('idempotencyKey')) {
      const raceWinner = await prisma.botBooking.findUnique({ where: { idempotencyKey } });
      return { booking: withId(raceWinner), created: false };
    }
    throw err;
  }
}

async function getBookingById(bookingId) {
  if (env.BACKEND_MODE === 'remote') {
    const { data } = await backendHttp.get(`/bookings/${bookingId}`);
    return data;
  }
  const prisma = getPrisma();
  return withId(await prisma.botBooking.findUnique({ where: { id: bookingId } }));
}

async function getBookingByNumber(bookingNumber) {
  if (env.BACKEND_MODE === 'remote') {
    const { data } = await backendHttp.get(`/bookings/number/${bookingNumber}`);
    return data;
  }
  const prisma = getPrisma();
  return withId(await prisma.botBooking.findUnique({ where: { bookingNumber } }));
}

async function getBookingsForCustomer(customerId, { limit = 5 } = {}) {
  if (env.BACKEND_MODE === 'remote') {
    const { data } = await backendHttp.get(`/customers/${customerId}/bookings`, { params: { limit } });
    return data;
  }
  const prisma = getPrisma();
  const rows = await prisma.botBooking.findMany({
    where: { customerId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return rows.map(withId);
}

async function getBookingSummary(bookingId) {
  if (env.BACKEND_MODE === 'remote') {
    const { data } = await backendHttp.get(`/bookings/${bookingId}/summary`);
    return data;
  }
  const prisma = getPrisma();
  const booking = await prisma.botBooking.findUnique({ where: { id: bookingId }, include: { payment: true } });
  if (!booking) return null;
  return {
    booking: withId(booking),
    payment: booking.payment ? withId(booking.payment) : null,
    liveLocation: booking.liveLocation?.updatedAt ? booking.liveLocation : null,
  };
}

async function updateBookingStatus(bookingId, status, extra = {}) {
  if (env.BACKEND_MODE === 'remote') {
    const { data } = await backendHttp.patch(`/bookings/${bookingId}/status`, { status, ...extra });
    return data;
  }
  const prisma = getPrisma();
  return withId(await prisma.botBooking.update({ where: { id: bookingId }, data: { status, ...extra } }));
}

module.exports = {
  createBooking,
  getBookingById,
  getBookingByNumber,
  getBookingsForCustomer,
  getBookingSummary,
  updateBookingStatus,
};
