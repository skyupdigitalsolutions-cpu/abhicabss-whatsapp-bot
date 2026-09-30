const env = require('../../config/env');
const { getPrisma } = require('../../config/db');
const backendHttp = require('./backendHttp');
const { calculateCancellationFee } = require('../../utils/cancellationPolicy');

function withId(row) {
  return row ? { ...row, _id: row.id } : row;
}

const NON_CANCELLABLE_STATUSES = ['CANCELLED', 'COMPLETED', 'ONGOING', 'EXPIRED'];

/** getAvailableActions — equivalent of GET /bookings/:id/actions. */
async function getAvailableActions(bookingId) {
  if (env.BACKEND_MODE === 'remote') {
    const { data } = await backendHttp.get(`/bookings/${bookingId}/actions`);
    return data.actions;
  }
  const prisma = getPrisma();
  const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
  if (!booking) return [];
  const actions = ['VIEW_DETAILS', 'INVOICE'];
  if (!NON_CANCELLABLE_STATUSES.includes(booking.status)) actions.push('CANCEL');
  if (['CONFIRMED', 'DRIVER_ASSIGNED', 'ONGOING'].includes(booking.status)) actions.push('TRACK');
  return actions;
}

/**
 * getCancellationQuote — equivalent of GET /bookings/:id/cancellation-quote.
 * Fee policy here is a placeholder tiered example; replace with the
 * real ABHI CABS policy once verified against the actual backend/source.
 */
async function getCancellationQuote(bookingId) {
  if (env.BACKEND_MODE === 'remote') {
    const { data } = await backendHttp.get(`/bookings/${bookingId}/cancellation-quote`);
    return data;
  }

  const prisma = getPrisma();
  const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
  if (!booking) throw new Error('BOOKING_NOT_FOUND');
  if (NON_CANCELLABLE_STATUSES.includes(booking.status)) {
    throw new Error('BOOKING_NOT_CANCELLABLE');
  }

  const hoursToPickup = (new Date(booking.pickupAt) - Date.now()) / (1000 * 60 * 60);
  const { fee, refundAmount, feePercent } = calculateCancellationFee({
    hoursToPickup,
    total: booking.fare.total,
  });

  return { bookingId, fee, refundAmount, feePercent, currency: 'INR' };
}

/** cancelBooking — equivalent of POST /bookings/:id/cancel. Requires explicit confirmation upstream. */
async function cancelBooking(bookingId, { reason, confirmedFee, confirmedRefund }) {
  if (env.BACKEND_MODE === 'remote') {
    const { data } = await backendHttp.post(`/bookings/${bookingId}/cancel`, { reason });
    return data;
  }

  const prisma = getPrisma();
  const booking = await prisma.booking.update({
    where: { id: bookingId },
    data: {
      status: 'CANCELLED',
      cancellation: {
        cancelledAt: new Date().toISOString(),
        reason,
        fee: confirmedFee,
        refundAmount: confirmedRefund,
      },
    },
  });
  return withId(booking);
}

module.exports = { getAvailableActions, getCancellationQuote, cancelBooking };
