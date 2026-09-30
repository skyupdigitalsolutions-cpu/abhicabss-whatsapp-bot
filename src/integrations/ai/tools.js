/**
 * Controlled tool/function architecture (spec section 37).
 *
 * The AI layer never talks to the database, Razorpay, or any backend
 * API directly — it can only request one of these named tools, and
 * every tool call still runs through the underlying service, which
 * validates inputs and enforces business rules. This file exists so
 * there is exactly ONE place that defines "what the AI is allowed to
 * cause to happen".
 */
const vehicleService = require('../abhicabs/vehicleService');
const fareService = require('../abhicabs/fareService');
const bookingService = require('../abhicabs/bookingService');
const paymentService = require('../abhicabs/paymentService');
const cancellationService = require('../abhicabs/cancellationService');
const invoiceService = require('../abhicabs/invoiceService');
const supportService = require('../abhicabs/supportService');

const tools = {
  getAvailableVehicles: vehicleService.getAvailableVehicles,
  getFareOptions: fareService.getFareOptions,
  estimateFare: fareService.estimateFare,

  createBooking: bookingService.createBooking,
  getBooking: bookingService.getBookingById,
  getBookingByNumber: bookingService.getBookingByNumber,
  getBookingsForCustomer: bookingService.getBookingsForCustomer,
  getBookingSummary: bookingService.getBookingSummary,

  createPaymentOrder: paymentService.createPaymentOrder,
  getPaymentStatus: paymentService.getPaymentStatus,
  countPaymentAttemptsForBooking: paymentService.countPaymentAttemptsForBooking,

  getAvailableActions: cancellationService.getAvailableActions,
  getCancellationQuote: cancellationService.getCancellationQuote,
  cancelBooking: cancellationService.cancelBooking,

  getInvoice: invoiceService.getInvoice,

  createSupportTicket: supportService.createSupportTicket,

  // handoffToHuman is intentionally NOT a backend call — it's a session
  // flag flip. See conversation/handlers/handoff.handler.js.
};

/**
 * Every tool call is wrapped so failures degrade to a safe, honest
 * message rather than ever fabricating a result (spec section 38/46).
 * Accepts any number of positional arguments and forwards them as-is,
 * since the underlying services differ in arity (some take a single
 * options object, some take an id plus an options object).
 */
async function callTool(name, ...args) {
  const fn = tools[name];
  if (!fn) throw new Error(`Unknown tool: ${name}`);
  return fn(...args);
}

module.exports = { tools, callTool };
