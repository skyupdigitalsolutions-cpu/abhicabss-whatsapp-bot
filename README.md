# ABHI CABS — WhatsApp AI Booking Bot

A 24/7 WhatsApp booking assistant for ABHI CABS, built on **Express (Node.js)** and **PostgreSQL** (via Prisma).

```
Customer → WhatsApp → MSG91 (WhatsApp BSP) → Webhook → Bot Backend
         → Conversation Engine → ABHI CABS Backend (local Postgres or remote API)
         → Database → WhatsApp Response
```

See `docs/ARCHITECTURE.md` for the full design, `docs/API_MAPPING.md` for the
bot-feature-to-endpoint table, and `docs/STATE_MACHINE.md` for the complete
conversation flow.

## Two backend modes

This project ships with `BACKEND_MODE=local` by default: it **is** the
backend (fares, bookings, payments, cancellations all live in its own
Postgres tables), so you can run it standalone with no other system.

If ABHI CABS already has a separate backend (as is the case — see
`docs/ARCHITECTURE.md` for what's been confirmed about the real one), set
`BACKEND_MODE=remote` and `BACKEND_API_URL` — every service in
`src/integrations/abhicabs/*` will proxy to it instead. **Important:** the
real backend requires customer auth (JWT) on every route, and currently has
no phone-based or service-account login path — see
`docs/ARCHITECTURE.md#remote-backend-auth-gap` before flipping this switch.

## Requirements

- Node.js 18+
- PostgreSQL 14+ (local, Docker, or a hosted provider — Railway, Supabase, Neon, Atlas-for-Postgres-style services, etc.)
- A MSG91 account with a verified WhatsApp number (Auth Key + Integrated Number — see "WhatsApp via MSG91" below)
- A Razorpay account (key id/secret, webhook secret)
- (Optional) An Anthropic API key, only used for free-text intent/entity
  extraction — the bot works with rule-based NLU alone if this is omitted

## Setup

```bash
cp .env.example .env
# fill in .env with real credentials — DATABASE_URL, MSG91_*, RAZORPAY_*

npm install              # also runs `prisma generate` automatically (postinstall)
npx prisma db push        # creates the bot's tables in your Postgres database
npm run seed:vehicles     # only needed in BACKEND_MODE=local
npm run dev               # nodemon, local development
# or
npm start                  # production
```

If your schema ever changes, `npx prisma db push` again syncs it — this
project uses `db push` rather than versioned migrations since the bot's
database is small and self-contained; switch to `prisma migrate` if you want
a migration history later.

## WhatsApp via MSG91

This bot sends and receives WhatsApp messages through **MSG91** (a WhatsApp
Business Solution Provider) rather than calling Meta's Graph API directly.
MSG91 wraps Meta's own message JSON inside its own envelope — see
`src/integrations/whatsapp/client.js` for the exact shape, and
`src/conversation/inbound.js` for how inbound webhook events are parsed.

1. In your MSG91 dashboard, add your WhatsApp number under **WhatsApp > Number**
   (New / Migrate Number, verify with the OTP Meta sends to that number).
2. Get your **AuthKey** from the top nav → `AuthKey`. Put it in `.env` as `MSG91_AUTH_KEY`.
3. Put your verified number (e.g. `918096000182`) in `.env` as `MSG91_INTEGRATED_NUMBER`.
4. Make up a random string for `MSG91_WEBHOOK_SECRET`, then in
   **WhatsApp > Webhook (New) > Create Webhook**, set:
   - Callback URL: `https://<your-domain>/webhook/whatsapp`
   - Event type: **On Inbound Request Received**
   - A custom header `X-Webhook-Secret` with the same value as `MSG91_WEBHOOK_SECRET`
     (this is what `requireMsg91WebhookSecret` middleware checks — MSG91 doesn't sign
     requests with an HMAC the way Meta does, so a shared-secret header is the auth mechanism)

Expose your local server publicly first (e.g. `ngrok http 3000`) so you have a
real HTTPS URL to paste into MSG91's webhook config. Register
`https://<your-domain>/webhook/razorpay` as a webhook URL in the Razorpay
dashboard, subscribed to `payment.captured` and `payment.failed`.

## Testing

```bash
npm test
```

Covers: date/time NLU resolution, idempotency key stability, the
cancellation fee policy, numbered-menu digit resolution, MSG91 inbound
payload parsing, and basic health/webhook-verification routes.
Booking/payment/cancellation *service* tests that need a live Postgres
are best run against a real test database (point `DATABASE_URL` at a
throwaway one, e.g. via Docker: `docker run -e POSTGRES_PASSWORD=x -p 5432:5432 postgres`).

## Deployment (Railway / Render / any Node host)

1. Set all `.env.example` variables as environment variables on the host.
2. Set `DATABASE_URL` to a **cloud** Postgres instance — your host's own
   Postgres server can't be reached from anywhere but your own machine.
3. `NODE_ENV=production` — this enables the production fail-fast check for
   missing MSG91/DB secrets.
4. Ensure `GET /health` is wired to the platform's health check.
5. The process must run continuously (not serverless request-scoped)
   so `node-cron` jobs (session timeout, abandoned-booking follow-up)
   keep firing.
6. Run `npx prisma db push` once against the production `DATABASE_URL`
   (or wire it into your deploy step) before the first real request.

## Project structure

```
prisma/
  schema.prisma        Postgres schema (Customer, Session, Booking, Payment, Vehicle, ...)
src/
  config/               env, logger, Postgres/Prisma connection
  integrations/
    whatsapp/            MSG91 client, message builders, webhook-secret verification
    razorpay/            Order creation, signature verification
    ai/                   Claude API client (NLU only) + controlled tool registry
    abhicabs/             Fare / booking / payment / cancellation / invoice / support
                          services — local Postgres or remote-backend-proxy, per BACKEND_MODE
  conversation/
    handlers/             One file per flow (language, menu, booking, payment, ...)
    nlu/                  Date/time and location parsing
    sessionRecord.js       Mongoose-like wrapper around a Postgres session row
    customerRecord.js      Same, for the customers table
    stateMachine.js        Routes inbound messages by session.state
    sessionManager.js      Session load/create/expire logic
  middleware/             Rate limiting, webhook secret auth, admin auth, errors
  routes/, controllers/    Express wiring
  jobs/                   node-cron: session timeout, abandoned-booking follow-up
  locales/                en/kn/hi (+ stubs for other listed languages), fallback to English
tests/                    Jest unit tests
docs/                     Architecture, API mapping, state machine diagrams
```

## Safety rules this codebase enforces

- **No invented prices, vehicles, booking IDs, or driver details** — every
  number/fact shown to a customer comes from `integrations/abhicabs/*`,
  never from the AI layer directly (see `integrations/ai/tools.js`).
- **No booking or payment is ever confirmed from a customer's message
  alone.** Bookings are created through `bookingService.createBooking`
  (idempotent); payments are only ever marked `CAPTURED` by
  `paymentService.verifyAndCapturePayment` or the Razorpay webhook,
  both of which require a verified signature.
- **Idempotency everywhere it matters** — booking creation and payment
  order creation are keyed so retried WhatsApp messages, webhook
  redelivery, or double button-taps can't create duplicates.
- **Human handoff** is a first-class state — once triggered, the bot
  stops auto-replying until a staff member resolves it via
  `POST /admin/handoffs/:sessionId/resolve`.
