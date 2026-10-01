const express = require('express');
const { receiveWebhook } = require('../controllers/webhook.controller');
const { receiveRazorpayWebhook } = require('../controllers/razorpayWebhook.controller');
const { requireMsg91WebhookSecret } = require('../middleware/webhookAuth');
const { webhookLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// MSG91 has no GET verification handshake (unlike Meta's direct Cloud
// API) — you just paste the POST URL below into MSG91's dashboard.
// This GET route exists only as a manual sanity check you can open in
// a browser to confirm the server is reachable.
// BUILD_TAG changes with each release, so opening this URL in a browser shows
// which version of the code Railway is actually running.
const BUILD_TAG = 'full-flow-tapfix-2026-10-01';
router.get('/whatsapp', (req, res) => res.status(200).send(`ABHI CABS WhatsApp webhook is up (build: ${BUILD_TAG})`));

router.post('/whatsapp', webhookLimiter, requireMsg91WebhookSecret, receiveWebhook);

router.post('/razorpay', webhookLimiter, receiveRazorpayWebhook);

module.exports = router;
