// One-off script: clears the stuck HUMAN_HANDOFF state for a specific
// WhatsApp number, resetting it to a fresh MAIN_MENU / English session.
// Run with: node reset-session.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const WHATSAPP_NUMBER = '916362168219'; // change this if testing a different number

async function main() {
  const result = await prisma.session.updateMany({
    where: { whatsappNumber: WHATSAPP_NUMBER },
    data: {
      state: 'MAIN_MENU',
      language: 'en',
      humanHandoff: false,
      handoffReason: null,
      draft: {},
      pendingOptionsMap: {},
    },
  });
  console.log('Sessions updated:', result.count);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});