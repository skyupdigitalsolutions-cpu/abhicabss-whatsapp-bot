const axios = require('axios');
const env = require('../../config/env');

/**
 * Used only when BACKEND_MODE=remote, i.e. the real ABHI CABS website
 * backend exists separately and this bot is just another channel in
 * front of it. Every service in this folder checks BACKEND_MODE and
 * either calls this client (remote) or the local Mongo models
 * (local — this bot doubling as the backend until one exists).
 *
 * When wiring this up to the real backend, verify these paths and
 * payload shapes against the actual source code first — do not assume
 * they match. See docs/API_MAPPING.md.
 */
const http = axios.create({
  baseURL: env.BACKEND_API_URL,
  timeout: 12000,
  headers: {
    'Content-Type': 'application/json',
    ...(env.BACKEND_API_KEY ? { Authorization: `Bearer ${env.BACKEND_API_KEY}` } : {}),
  },
});

module.exports = http;
