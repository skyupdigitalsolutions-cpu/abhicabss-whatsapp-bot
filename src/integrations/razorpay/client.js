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
  fetchPayment,
  verifyCheckoutSignature,
  verifyWebhookSignature,
};
