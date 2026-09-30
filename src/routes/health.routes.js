const express = require('express');
const { getPrisma } = require('../config/db');

const router = express.Router();

router.get('/health', async (req, res) => {
  try {
    const prisma = getPrisma();
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'ok', db: 'connected', uptime: process.uptime() });
  } catch (err) {
    res.status(503).json({ status: 'degraded', db: 'disconnected', uptime: process.uptime() });
  }
});

module.exports = router;
