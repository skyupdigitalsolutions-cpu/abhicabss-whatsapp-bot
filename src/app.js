const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const pinoHttp = require('pino-http');

const { logger } = require('./config/logger');
const healthRoutes = require('./routes/health.routes');
const webhookRoutes = require('./routes/webhook.routes');
const adminRoutes = require('./routes/admin.routes');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

const app = express();

// Railway (and ngrok before it) sits in front of the app as a proxy.
// Trust one proxy hop so the real client IP is used by express-rate-limit
// instead of every customer looking like the same proxy address.
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors());
app.use(
  pinoHttp({
    logger,
    // Never write webhook secrets or signatures to the logs.
    redact: {
      paths: ['req.headers["x-webhook-secret"]', 'req.headers["x-razorpay-signature"]', 'req.headers.authorization'],
      censor: '[hidden]',
    },
  })
);

// Capture the raw body for webhook signature verification (Meta + Razorpay)
// while still parsing JSON normally for every other route.
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
    limit: '2mb',
  })
);

app.use('/', healthRoutes);
app.use('/webhook', webhookRoutes);
app.use('/admin', adminRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
