const env = require('../../config/env');

/**
 * MSG91's "Webhook (New)" system does not sign requests with an HMAC
 * the way Meta does — instead it lets you attach custom headers
 * (key/value pairs) to every webhook call it makes, configured in the
 * MSG91 dashboard when you create the webhook.
 *
 * The pattern used here: when creating the webhook in MSG91, add a
 * custom header such as:
 *   X-Webhook-Secret: <same random string as MSG91_WEBHOOK_SECRET in .env>
 *
 * and this function just checks that header matches. It is a shared
 * secret, not a cryptographic signature — still effective at blocking
 * unauthenticated requests, since anyone without the secret gets a 401.
 */
function verifyMsg91WebhookSecret(headers) {
  const provided = headers['x-webhook-secret'];
  if (!env.MSG91_WEBHOOK_SECRET) return true; // not configured yet — allow through in dev
  return provided === env.MSG91_WEBHOOK_SECRET;
}

module.exports = { verifyMsg91WebhookSecret };
