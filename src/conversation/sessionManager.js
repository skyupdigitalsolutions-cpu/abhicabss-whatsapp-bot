const dayjs = require('dayjs');
const { getPrisma } = require('../config/db');
const { wrapSession } = require('./sessionRecord');
const { wrapCustomer } = require('./customerRecord');
const env = require('../config/env');
const { STATES } = require('./states');

/**
 * Finds or creates the Customer profile for a WhatsApp number, never
 * duplicating records (spec section 32) — phone number is the stable
 * lookup key.
 */
async function findOrCreateCustomer(whatsappNumber) {
  const prisma = getPrisma();
  let row = await prisma.customer.findUnique({ where: { whatsappNumber } });

  if (!row) {
    row = await prisma.customer.create({ data: { whatsappNumber } });
  } else {
    row = await prisma.customer.update({
      where: { id: row.id },
      data: { lastInteractionAt: new Date() },
    });
  }
  return wrapCustomer(row);
}

/**
 * Finds the session for this number, or creates a fresh one at
 * LANGUAGE_SELECTION. If a session exists but has expired (past
 * SESSION_TIMEOUT_MINUTES of inactivity) and still has an in-progress
 * draft booking, it is not deleted — it's surfaced as a "resume?"
 * prompt (spec section 31) rather than silently reset.
 */
async function getOrCreateSession(whatsappNumber) {
  const prisma = getPrisma();
  const customer = await findOrCreateCustomer(whatsappNumber);

  let row = await prisma.session.findUnique({ where: { whatsappNumber } });

  if (!row) {
    row = await prisma.session.create({
      data: {
        whatsappNumber,
        customerId: customer.id,
        // No language question: customers start in English on the main menu.
        language: 'en',
        state: STATES.MAIN_MENU,
      },
    });
    return { session: wrapSession(row), customer, resumed: false, wasExpired: false };
  }

  const session = wrapSession(row);

  const idleMinutes = dayjs().diff(dayjs(session.lastMessageAt), 'minute');
  const hasInProgressDraft = session.state.startsWith('BOOKING_') && session.draft?.tripType;

  const wasExpired =
    idleMinutes > env.SESSION_TIMEOUT_MINUTES &&
    ![STATES.MAIN_MENU, STATES.LANGUAGE_SELECTION, STATES.SESSION_EXPIRED].includes(session.state);

  if (wasExpired && hasInProgressDraft && session.state !== STATES.SESSION_EXPIRED) {
    session.previousState = session.state;
    session.state = STATES.SESSION_EXPIRED;
    await session.save();
  } else if (wasExpired) {
    session.state = session.language ? STATES.MAIN_MENU : STATES.LANGUAGE_SELECTION;
    session.resetDraft();
    await session.save();
  }

  return { session, customer, resumed: false, wasExpired };
}

async function touchSession(session) {
  session.lastMessageAt = new Date();
  await session.save();
}

async function transition(session, nextState) {
  session.previousState = session.state;
  session.state = nextState;
  await session.save();
}

module.exports = { getOrCreateSession, touchSession, transition, findOrCreateCustomer };
