const env = require('./config/env');
const { logger } = require('./config/logger');
const { connectDB, disconnectDB } = require('./config/db');
const app = require('./app');
const { startJobs, stopJobs } = require('./jobs');

let server;

async function start() {
  await connectDB();
  logger.info('[server] PostgreSQL (Prisma) ready');

  server = app.listen(env.PORT, () => {
    logger.info(`[server] ABHI CABS WhatsApp bot listening on port ${env.PORT} (${env.NODE_ENV})`);
  });

  startJobs();
}

async function shutdown(signal) {
  logger.info(`[server] received ${signal}, shutting down gracefully...`);
  stopJobs();

  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await disconnectDB();

  logger.info('[server] shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, '[server] unhandled promise rejection');
});
process.on('uncaughtException', (err) => {
  logger.error({ err: err.message, stack: err.stack }, '[server] uncaught exception');
  // Fail fast rather than continue in a possibly-corrupt state; the
  // process manager (Railway/Render/PM2) is expected to restart us.
  process.exit(1);
});

start().catch((err) => {
  logger.error({ err: err.message }, '[server] failed to start');
  process.exit(1);
});
