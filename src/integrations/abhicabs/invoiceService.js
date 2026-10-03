const env = require('../../config/env');
const { getPrisma } = require('../../config/db');
const backendHttp = require('./backendHttp');

/**
 * getInvoice Ã¢â‚¬â€ equivalent of GET /bookings/:id/invoice. Returns null
 * (never a fabricated URL) if no invoice exists yet, e.g. booking not
 * yet completed/paid.
 */
async function getInvoice(bookingId) {
  if (env.BACKEND_MODE === 'remote') {
    try {
      const { data } = await backendHttp.get(`/bookings/${bookingId}/invoice`);
      return data.invoiceUrl || null;
    } catch (err) {
      if (err.response?.status === 404) return null;
      throw err;
    }
  }

  const prisma = getPrisma();
  const booking = await prisma.botBooking.findUnique({ where: { id: bookingId } });
  if (!booking) throw new Error('BOOKING_NOT_FOUND');
  return booking.invoiceUrl || null; // populated by whatever generates invoices in this deployment
}

module.exports = { getInvoice };
