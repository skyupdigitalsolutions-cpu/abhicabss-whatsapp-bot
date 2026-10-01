const { PrismaClient } = require('@prisma/client');
const { logger } = require('./logger');

let prisma = null;

/**
 * Single shared Prisma client for the whole process. connectDB/disconnectDB
 * keep the same names/shape server.js already calls, so nothing else about
 * the boot sequence needed to change when this moved from Mongoose to Prisma.
 */
async function connectDB() {
  if (prisma) return prisma;

  prisma = new PrismaClient({
    log: [{ emit: 'event', level: 'error' }, { emit: 'event', level: 'warn' }],
  });

  prisma.$on('error', (e) => logger.error({ err: e.message }, '[db] Prisma error'));
  prisma.$on('warn', (e) => logger.warn({ warn: e.message }, '[db] Prisma warning'));

  // $connect isn't strictly required (Prisma lazy-connects on first query),
  // but calling it explicitly here means a bad DATABASE_URL fails fast at
  // boot instead of on the first customer message.
  await prisma.$connect();
  logger.info('[db] PostgreSQL connected (Prisma)');
  return prisma;
}

async function disconnectDB() {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
}

/** Accessor used by every service/model-touching file. Throws clearly if called before connectDB(). */
function getPrisma() {
  if (!prisma) {
    throw new Error('Prisma client not initialized — connectDB() must run before any query.');
  }
  return prisma;
}

module.exports = { connectDB, disconnectDB, getPrisma };
