require('dotenv').config();

function required(name, fallback = undefined) {
  const v = process.env[name] ?? fallback;
  return v;
}

const env = {
  NODE_ENV: required('NODE_ENV', 'development'),
  PORT: parseInt(required('PORT', '3000'), 10),

  DATABASE_URL: required('DATABASE_URL', 'mongodb://127.0.0.1:27017/abhicabs_whatsapp'),

  // ─── MSG91 (WhatsApp BSP) ─────────────────────────────────
  // This deployment sends/receives WhatsApp messages through MSG91
  // rather than talking to Meta's Graph API directly. MSG91 wraps
  // Meta's own message JSON inside its own envelope — see
  // integrations/whatsapp/client.js for the exact shape.
  MSG91_AUTH_KEY: required('MSG91_AUTH_KEY'),
  MSG91_INTEGRATED_NUMBER: required('MSG91_INTEGRATED_NUMBER'), // e.g. 918096000182
  MSG91_WEBHOOK_SECRET: required('MSG91_WEBHOOK_SECRET'), // custom header value you set when creating the MSG91 webhook

  AI_API_KEY: required('AI_API_KEY'),
  AI_MODEL: required('AI_MODEL', 'claude-sonnet-4-6'),

  BACKEND_MODE: required('BACKEND_MODE', 'local'), // 'local' | 'remote'
  BACKEND_API_URL: required('BACKEND_API_URL'),
  BACKEND_API_KEY: required('BACKEND_API_KEY'),

  RAZORPAY_KEY_ID: required('RAZORPAY_KEY_ID'),
  RAZORPAY_KEY_SECRET: required('RAZORPAY_KEY_SECRET'),
  RAZORPAY_WEBHOOK_SECRET: required('RAZORPAY_WEBHOOK_SECRET'),

  // Road distance for fares (Google Distance Matrix API). Optional: without it,
  // typed addresses fall back to a 50 km default and fares will be inaccurate.
  GOOGLE_MAPS_API_KEY: required('GOOGLE_MAPS_API_KEY'),

  // "Partial Payment" = this percentage of the fare, paid now. The rest is due later.
  PARTIAL_PAYMENT_PERCENT: Math.min(99, Math.max(1, parseInt(required('PARTIAL_PAYMENT_PERCENT', '25'), 10) || 25)),

  // Shown to customers under "Contact Us".
  SUPPORT_PHONE: required('SUPPORT_PHONE', '+91 80960 00182'),

  SESSION_TIMEOUT_MINUTES: parseInt(required('SESSION_TIMEOUT_MINUTES', '30'), 10),
  ABANDONED_BOOKING_FOLLOWUP_MINUTES: parseInt(
    required('ABANDONED_BOOKING_FOLLOWUP_MINUTES', '45'),
    10
  ),

  REDIS_URL: required('REDIS_URL'),
  ADMIN_API_KEY: required('ADMIN_API_KEY', 'change_me_admin_key'),

  TIMEZONE: 'Asia/Kolkata',
};

// Fail fast in production if critical secrets are missing.
if (env.NODE_ENV === 'production') {
  const criticalForProd = ['MSG91_AUTH_KEY', 'MSG91_INTEGRATED_NUMBER', 'DATABASE_URL'];
  const missing = criticalForProd.filter((k) => !env[k]);
  if (missing.length) {
    // eslint-disable-next-line no-console
    console.error(`[FATAL] Missing required production env vars: ${missing.join(', ')}`);
    process.exit(1);
  }
}

module.exports = env;
