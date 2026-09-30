# Architecture

## Note on the original request

The original specification asked for this bot to be built by first
analyzing an uploaded ABHI CABS website ZIP (existing frontend,
backend APIs, database, fare/booking/payment logic) and reusing it
wherever possible. **No such ZIP was ever attached to the
conversation** — only the requirements document was provided. This
codebase is therefore built as a **standalone, production-shaped
backend** (`BACKEND_MODE=local`) that a real ABHI CABS backend can
either sit behind (`BACKEND_MODE=remote`, see below) or be replaced by
piece-by-piece once the real source is available.

If/when the actual website project is shared, the correct next step is:

1. Read `package.json`, `.env.example`, `BACKEND_CONNECTION.md`, and the
   API client / booking / fare / payment services.
2. Compare every endpoint and payload shape against
   `docs/API_MAPPING.md` below and correct any mismatches.
3. Flip `BACKEND_MODE=remote` and point `BACKEND_API_URL` at the real
   backend, so this bot becomes a pure additional channel rather than
   a second source of truth.

## WhatsApp transport: MSG91, not direct Meta

This deployment sends/receives WhatsApp messages through **MSG91** (a WhatsApp
Business Solution Provider), not by calling `graph.facebook.com` directly.
MSG91 wraps Meta's own message JSON inside its own envelope on the way out,
and relays Meta's own webhook event data (flattened into its own field names)
on the way in. Concretely:

- **Outbound** (`src/integrations/whatsapp/client.js`): every send POSTs to
  `https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/`
  with an `authkey` header, wrapping the Meta-native message object
  (`{ to, type, text/interactive/document, ... }`, already built by
  `messageBuilder.js`) inside `{ integrated_number, content_type, payload }`.
- **Inbound** (`src/conversation/inbound.js`): MSG91 posts one flat JSON
  event per message (not Meta's nested `entry/changes/value/messages` array).
  Confirmed field names — `customerNumber`, `contentType`, `text`, `uuid`,
  `button` (JSON string for quick-reply taps), `interactive` (JSON string,
  assumed to carry Meta's own `button_reply`/`list_reply` shape since MSG91
  is a Meta BSP passthrough), `latitude`/`longitude` for shared locations.
- **Webhook auth** (`src/integrations/whatsapp/verifySignature.js`): MSG91
  doesn't sign webhook calls with an HMAC the way Meta does. Instead it lets
  you attach a custom header when you create the webhook in its dashboard —
  this codebase expects `X-Webhook-Secret` to match `MSG91_WEBHOOK_SECRET`.

If the exact `interactive` field shape MSG91 sends in practice differs from
what's assumed here, only `normalizeInboundMessage` in `inbound.js` needs
correcting — everything downstream (state machine, handlers) is unaffected
since it only ever sees the normalized `{ interactiveId, interactiveTitle }`
shape.

## Remote backend auth gap

*(This section documents what was found analyzing the real ABHI CABS backend
source — relevant only once `BACKEND_MODE=remote` is actually turned on.)*

The real backend (Node.js + Express + Prisma + PostgreSQL) requires a JWT
Bearer token on every route the bot needs (`/fares`, `/bookings`,
`/payments`, etc.), obtained via **email + OTP** login
(`POST /api/v1/auth/otp/request` → `POST /api/v1/auth/otp/verify`). There is
currently no phone-based login and no trusted service-account/API-key path
for a bot to act on a customer's behalf using only their WhatsApp number.

Proposed fix (pending the backend team): a `requireServiceKey` middleware
checking a shared secret header, paired with a phone-based
"resolve or create customer" step, applied only to the routes the bot calls
— leaving the existing customer-app login flow untouched. Once that (or
whatever the team decides instead) exists, `BACKEND_MODE=remote` plus the new
auth header/flow can be wired into `src/integrations/abhicabs/*` in place of
the current local-Postgres logic.

## High-level flow

```
Customer
  │
  ▼
WhatsApp Business Cloud API
  │  (webhook: message/status events)
  ▼
POST /webhook/whatsapp  (src/controllers/webhook.controller.js)
  │  1. verify MSG91 shared-secret header (X-Webhook-Secret)
  │  2. ACK 200 immediately
  │  3. dedupe by WhatsApp message ID (ProcessedMessage, unique index)
  │  4. per-customer rate limit
  ▼
Conversation Engine (src/conversation/*)
  │  - sessionManager: load/create Session, handle timeout/resume
  │  - stateMachine: dispatch by session.state to one handler
  │  - handlers/*: read message, update draft, call tools, send replies
  │  - nlu/*: date/time/location parsing; ai/intentExtractor for free text
  ▼
Controlled Tool Registry (src/integrations/ai/tools.js)
  │  the ONLY functions the conversation/AI layer may invoke
  ▼
ABHI CABS Services (src/integrations/abhicabs/*)
  │  fareService · bookingService · paymentService · cancellationService
  │  · invoiceService · vehicleService · supportService
  │  each checks BACKEND_MODE:
  │    local  → PostgreSQL via Prisma (this bot IS the backend)
  │    remote → backendHttp (real ABHI CABS backend)
  ▼
PostgreSQL  (or the real ABHI CABS database, via the real backend)
  │
  ▼
WhatsApp Response (src/integrations/whatsapp/*)
```

Razorpay payment verification is a separate, parallel path:

```
Razorpay ── POST /webhook/razorpay ──▶ razorpayWebhook.controller.js
                                          │ verify signature
                                          │ update Payment.status
                                          │ update Booking.status
                                          ▼
                                    notify customer via WhatsApp
```

## Why a controlled tool registry (not free function-calling)

The spec's "AI architecture" section asks for the AI to choose from a
fixed set of tools while the backend validates every call. This
codebase implements that literally but conservatively: **conversation
handlers** (deterministic code, not an LLM) decide which tool to call
and with what arguments for every structured step (fare lookup,
booking creation, cancellation, etc). The AI model
(`integrations/ai/aiClient.js` + `intentExtractor.js`) is used only for:

- classifying free-text intent as a fallback when a customer types
  instead of tapping a button, and
- extracting entities (pickup/drop/date phrase/vehicle preference) from
  mixed-language natural text.

The AI **never** calls a tool directly and never sees or produces a
fare, booking ID, or payment status — those always come from a
service function, cached/re-verified at the moment they're needed
(e.g. `fareService.estimateFare` re-validates a quote right before
booking creation rather than trusting whatever was shown minutes
earlier).

## Idempotency

- **Booking creation**: `utils/idempotency.bookingIdempotencyKey`
  derives a deterministic key from `(sessionId, draft contents)`. A
  duplicate WhatsApp message, a webhook redelivery, or a double tap on
  "Confirm & Pay" all resolve to the same key, and
  `bookingService.createBooking` looks up that key before creating
  anything — a repeat returns the existing booking instead of a new one.
- **Payment orders**: keyed by `(bookingId, attempt)`; retrying a
  failed payment increments `attempt`, producing a new key deliberately
  (a genuinely new charge attempt), while accidental double-submits of
  the *same* attempt hit the same key and return the existing order.
- **Inbound WhatsApp messages**: `ProcessedMessage` has a unique index
  on `whatsappMessageId`; a second insert throws `E11000`, which the
  webhook controller treats as "already handled, skip".

## Payment trust boundary

`paymentService.verifyAndCapturePayment` and the Razorpay webhook
handler are the **only** two code paths allowed to set
`Payment.status = 'CAPTURED'`. Both require a valid HMAC signature
(Razorpay Checkout's `razorpaySignature`, or the webhook's
`X-Razorpay-Signature` header) verified against `RAZORPAY_KEY_SECRET` /
`RAZORPAY_WEBHOOK_SECRET`. Nothing in the conversation handlers can
mark a payment captured from chat text — see
`payment.handler.js:handlePaymentPendingReply`, which explicitly replies
"still verifying" to anything other than a retry/support button.

## Human handoff

`session.humanHandoff` is a hard gate checked first in
`stateMachine.processInboundMessage`. Once true, the state machine logs
and returns without calling any handler — no automated reply is sent.
Staff clear it via `POST /admin/handoffs/:sessionId/resolve`, which also
resets the session to `MAIN_MENU`. Triggers are centralized in
`handlers/handoff.handler.js:escalateToHuman` and called from: explicit
"talk to human" intent, no-vehicles-available, unhandled handler
exceptions, and payment-issue support requests.

## What would need to change for a real production launch

- **Fare engine**: `fareService`'s local mode uses straight-line
  (haversine) distance and placeholder per-km rates — replace with
  real routing (Google Distance Matrix / Maps Directions) and the real
  ABHI CABS rate card, or point `BACKEND_MODE=remote` at the real fare API.
- **Cancellation policy**: `utils/cancellationPolicy.js`'s tiered fee
  percentages are illustrative placeholders — replace with the actual
  policy.
- **Checkout UX**: `bookingReview.handler.js:startPayment` currently
  sends the Razorpay order ID as text. A real deployment should send a
  hosted Razorpay Payment Link (or a WhatsApp Flow) so the customer can
  actually pay from the chat.
- **Queueing**: the webhook controller processes messages inline
  (fire-and-forget) after acknowledging the MSG91 webhook call. At scale, replace this
  with a real queue (BullMQ/SQS) and a separate worker process.
- **Geocoding**: typed pickup/drop addresses are stored with
  `latitude/longitude = null` unless the customer shares a location pin.
  Add a geocoding call if precise coordinates are required downstream.
- **WhatsApp templates**: `jobs/abandonedBooking.job.js` references a
  template name (`abandoned_booking_followup`) that must be created and
  approved in WhatsApp Manager before this job can actually send anything.
