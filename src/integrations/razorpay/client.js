const Razorpay = require('razorpay');
const crypto = require('crypto');
const env = require('../../config/env');

// Lazily constructed: the Razorpay SDK throws synchronously at
// construction time if key_id/key_secret are missing, which would
// otherwise crash the whole process (and every test file that
// transitively requires this module) before .env is ever configured.
// Real calls still fail loudly — via getClient() below — if credentials
// are genuinely absent when a payment operation is attempted.
let _client = null;
function getClient() {
  if (_client) return _client;
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    throw new Error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not configured');
  }
  _client = new Razorpay({ key_id: env.RAZORPAY_KEY_ID, key_secret: env.RAZORPAY_KEY_SECRET });
  return _client;
}

/**
 * Create a Razorpay order. amountInRupees is converted to paise as
 * Razorpay requires. receipt should be the booking's idempotency key
 * or booking number so retries map to the same order where possible.
 */
async function createOrder({ amountInRupees, receipt, notes = {} }) {
  const order = await getClient().orders.create({
    amount: Math.round(amountInRupees * 100),
    currency: 'INR',
    receipt,
    notes,
  });
  return order; // { id, amount, currency, status, ... }
}

/**
 * Create a Razorpay Payment Link — a hosted page the customer opens from
 * WhatsApp and pays on (UPI / cards / netbanking). This is how a customer
 * actually pays inside a chat: an Order alone has no page to pay on.
 * The link is valid for 24 hours. Razorpay tells us it was paid via the
 * `payment_link.paid` webhook, which is the only thing that confirms a booking.
 */
async function createPaymentLink({ amountInRupees, referenceId, description, customerName, customerPhone, notes = {} }) {
  const digits = String(customerPhone || '').replace(/\D/g, '');
  return getClient().paymentLink.create({
    amount: Math.round(amountInRupees * 100),
    currency: 'INR',
    accept_partial: false,
    reference_id: String(referenceId).slice(0, 40),
    description: String(description).slice(0, 2000),
    ...(customerName || digits
      ? { customer: { ...(customerName ? { name: customerName } : {}), ...(digits ? { contact: `+${digits}` } : {}) } }
      : {}),
    notify: { sms: false, email: false },
    reminder_enable: false,
    expire_by: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    notes,
  }); // { id: 'plink_...', short_url, status, ... }
}

async function fetchPaymentLink(linkId) {
  return getClient().paymentLink.fetch(linkId);
}

async function fetchPayment(paymentId) {
  return getClient().payments.fetch(paymentId);
}

/**
 * Verify the signature returned by Razorpay Checkout (or the
 * order.paid / payment.captured webhook) before EVER marking a
 * payment as CAPTURED. This is the only trustworthy proof of payment —
 * a customer's WhatsApp message saying "I paid" is never sufficient.
 */
function verifyCheckoutSignature({ razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
  const expected = crypto
    .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');
  return expected === razorpaySignature;
}

function verifyWebhookSignature(rawBody, signatureHeader) {
  const expected = crypto
    .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader || ''));
  } catch {
    return false;
  }
}

module.exports = {
  getClient,
  createOrder,
  createPaymentLink,
  fetchPaymentLink,
  fetchPayment,
  verifyCheckoutSignature,
  verifyWebhookSignature,
};
