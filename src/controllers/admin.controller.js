const { getPrisma } = require('../config/db');
const { wrapSession } = require('../conversation/sessionRecord');
const { STATES } = require('../conversation/states');

function withId(row) {
  return row ? { ...row, _id: row.id } : row;
}

/** GET /admin/stats Ã¢â‚¬â€ high-level monitoring numbers (spec section 50). */
async function getStats(req, res) {
  const prisma = getPrisma();
  const [
    activeConversations,
    totalConversations,
    totalBookings,
    successfulPayments,
    failedPayments,
    abandonedBookings,
    humanHandoffs,
  ] = await Promise.all([
    prisma.session.count({ where: { lastMessageAt: { gte: new Date(Date.now() - 30 * 60 * 1000) } } }),
    prisma.session.count(),
    prisma.botBooking.count({ where: { channel: 'WHATSAPP' } }),
    prisma.botPayment.count({ where: { status: 'CAPTURED' } }),
    prisma.botPayment.count({ where: { status: 'FAILED' } }),
    prisma.abandonedBooking.count({ where: { recovered: false } }),
    prisma.session.count({ where: { humanHandoff: true } }),
  ]);

  res.json({
    activeConversations,
    totalConversations,
    totalBookings,
    successfulPayments,
    failedPayments,
    abandonedBookings,
    humanHandoffs,
  });
}

/** GET /admin/handoffs Ã¢â‚¬â€ conversations currently waiting for a human. */
async function getHandoffs(req, res) {
  const prisma = getPrisma();
  const rows = await prisma.session.findMany({
    where: { humanHandoff: true },
    orderBy: { lastMessageAt: 'desc' },
    take: 50,
    include: { customer: true },
  });
  res.json(rows.map((r) => ({ ...withId(r), customer: withId(r.customer) })));
}

/** GET /admin/support-tickets Ã¢â‚¬â€ open tickets for staff triage. */
async function getSupportTickets(req, res) {
  const prisma = getPrisma();
  const status = req.query.status || 'OPEN';
  const tickets = await prisma.supportTicket.findMany({
    where: { status },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  res.json(tickets.map(withId));
}

/** POST /admin/handoffs/:sessionId/resolve Ã¢â‚¬â€ staff clears a handoff, returning the bot to MAIN_MENU. */
async function resolveHandoff(req, res) {
  const prisma = getPrisma();
  const row = await prisma.session.findUnique({ where: { id: req.params.sessionId } });
  if (!row) return res.status(404).json({ error: 'Session not found' });

  const session = wrapSession(row);
  session.humanHandoff = false;
  session.handoffReason = null;
  session.state = STATES.MAIN_MENU;
  session.resetDraft();
  await session.save();

  res.json({ ok: true });
}

module.exports = { getStats, getHandoffs, getSupportTickets, resolveHandoff };
