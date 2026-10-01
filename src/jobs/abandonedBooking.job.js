const dayjs = require('dayjs');
const env = require('../config/env');
const { logger } = require('../config/logger');
const { getPrisma } = require('../config/db');
const { sendMessage } = require('../integrations/whatsapp/client');

// The exact template name approved for your WhatsApp Business number in MSG91.
// Until a template is approved, leave ABANDONED_BOOKING_TEMPLATE unset in Railway
// and this job will skip sending (and is also unscheduled in jobs/index.js).
const TEMPLATE_NAME = env.ABANDONED_BOOKING_TEMPLATE || '';

/**
 * Sends a follow-up ONLY via an approved WhatsApp message template
 * (spec section 44) — never free-form text — because these customers
 * are outside the 24-hour customer-service messaging window by the
 * time this fires.
 */
async function sendAbandonedBookingFollowUps() {
  // No approved template configured yet → do nothing (prevents the HTTP 400
  // "payload not found in request" failures from a non-existent template).
  if (!TEMPLATE_NAME) {
    return;
  }

  const prisma = getPrisma();
  const cutoff = dayjs().subtract(env.ABANDONED_BOOKING_FOLLOWUP_MINUTES, 'minute').toDate();

  const pending = await prisma.abandonedBooking.findMany({
    where: {
      followUpSentAt: null,
      recovered: false,
      abandonedAt: { lt: cutoff },
    },
    take: 100,
  });

  let sent = 0;
  for (const record of pending) {
    const { pickup, drop } = record.snapshot || {};
    try {
      // eslint-disable-next-line no-await-in-loop
      await sendMessage({
        to: record.whatsappNumber,
        type: 'template',
        template: {
          name: TEMPLATE_NAME,
          language: { code: 'en' },
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', text: pickup?.address || 'your pickup' },
                { type: 'text', text: drop?.address || 'your destination' },
              ],
            },
          ],
        },
      });
      // eslint-disable-next-line no-await-in-loop
      await prisma.abandonedBooking.update({
        where: { id: record.id },
        data: { followUpSentAt: new Date() },
      });
      sent += 1;
    } catch (err) {
      // Mark it as attempted so a failing record is not retried every 10 minutes forever.
      // eslint-disable-next-line no-await-in-loop
      await prisma.abandonedBooking
        .update({ where: { id: record.id }, data: { followUpSentAt: new Date() } })
        .catch(() => {});
      logger.error(
        { err: err.message, whatsappNumber: record.whatsappNumber },
        '[job:abandonedBooking] follow-up send failed'
      );
    }
  }

  if (sent) {
    logger.info({ count: sent }, '[job:abandonedBooking] follow-ups sent');
  }
}

module.exports = { sendAbandonedBookingFollowUps };
