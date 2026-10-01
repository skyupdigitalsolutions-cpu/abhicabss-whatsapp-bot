const env = require('../../config/env');
const { getPrisma } = require('../../config/db');
const backendHttp = require('./backendHttp');

function withId(row) {
  return row ? { ...row, _id: row.id } : row;
}

async function createSupportTicket({ customerId, whatsappNumber, name, bookingId, category, message, conversationId }) {
  const prisma = getPrisma();

  if (env.BACKEND_MODE === 'remote') {
    const { data } = await backendHttp.post('/support/tickets', {
      customerId, whatsappNumber, name, bookingId, category, message, conversationId,
    });
    const ticket = await prisma.supportTicket.create({
      data: { ...data, customerId, whatsappNumber, conversationId },
    });
    return withId(ticket);
  }

  const ticket = await prisma.supportTicket.create({
    data: {
      customerId,
      whatsappNumber,
      name,
      bookingId: bookingId || null,
      category,
      message,
      conversationId,
    },
  });
  return withId(ticket);
}

module.exports = { createSupportTicket };
