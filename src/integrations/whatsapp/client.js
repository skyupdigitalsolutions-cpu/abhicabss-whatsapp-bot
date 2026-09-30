const axios = require('axios');
const env = require('../../config/env');
const { logger } = require('../../config/logger');

const http = axios.create({
  baseURL: 'https://api.msg91.com/api/v5/whatsapp',
  timeout: 10000,
  headers: {
    authkey: env.MSG91_AUTH_KEY,
    'Content-Type': 'application/json',
  },
});

async function sendMessage(payload) {
  const body = {
    integrated_number: env.MSG91_INTEGRATED_NUMBER,
    recipient_number: payload.to,
    content_type: payload.type,
  };

  if (payload.type === 'text') {
    body.text = payload.text?.body ?? '';
  } else if (payload.type === 'interactive') {
    body.interactive = payload.interactive;
  } else if (payload.type === 'document') {
    body.document = payload.document;
  } else {
    body[payload.type] = payload[payload.type];
  }

  try {
    const res = await http.post('/whatsapp-outbound-message/', body);
    logger.info({ to: payload.to, content_type: payload.type, msg91Response: res.data }, '[msg91] send response');
    return res.data;
  } catch (err) {
    logger.error(
      { err: err.response?.data || err.message, to: payload.to, content_type: payload.type },
      '[msg91] send failed'
    );
    throw err;
  }
}

async function markAsRead() {
  return null;
}

module.exports = { sendMessage, markAsRead };