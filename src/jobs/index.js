const cron = require('node-cron');
const { logger } = require('../config/logger');
const { runSessionTimeoutSweep } = require('./sessionTimeout.job');
// Abandoned-booking follow-ups are disabled: they send a WhatsApp *template*,
// and no approved template is configured in MSG91 yet, so every run failed with
// "payload not found in request" (HTTP 400). Re-enable once a template is approved.
// const { sendAbandonedBookingFollowUps } = require('./abandonedBooking.job');

const scheduled = [];

function startJobs() {
  // Every 5 minutes: expire idle sessions safely.
  scheduled.push(
    cron.schedule('*/5 * * * *', () => {
      runSessionTimeoutSweep().catch((err) =>
        logger.error({ err: err.message }, '[jobs] sessionTimeout sweep failed')
      );
    })
  );

  // Abandoned-booking follow-ups are turned OFF until an approved MSG91 template exists.
  // To re-enable: uncomment the require above and the block below.
  // scheduled.push(
  //   cron.schedule('*/10 * * * *', () => {
  //     sendAbandonedBookingFollowUps().catch((err) =>
  //       logger.error({ err: err.message }, '[jobs] abandonedBooking sweep failed')
  //     );
  //   })
  // );

  logger.info('[jobs] scheduled background jobs started');
}

function stopJobs() {
  scheduled.forEach((task) => task.stop());
}

module.exports = { startJobs, stopJobs };
