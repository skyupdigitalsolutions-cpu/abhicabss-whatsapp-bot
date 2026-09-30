# Conversation State Machine

Full state list: `src/conversation/states.js`. Dispatch table:
`src/conversation/stateMachine.js:STATE_HANDLERS`.

State is persisted on the `Session` document (`state` field), so the
machine is fully recoverable after a server restart — there is no
in-memory conversation state anywhere in this codebase (the one
exception, `session._cachedOptions` in `booking.handler.js`, is
immediately followed by persisting the same data into
`session.draft._vehicleOptions`, which IS saved to Postgres).

```mermaid
stateDiagram-v2
    [*] --> LANGUAGE_SELECTION
    LANGUAGE_SELECTION --> MAIN_MENU

    MAIN_MENU --> BOOKING_TRIP_TYPE: Book a Cab / Fare Estimate
    MAIN_MENU --> MY_BOOKINGS: My Booking
    MAIN_MENU --> BOOKING_DETAILS: (select a booking)
    MAIN_MENU --> SUPPORT_CATEGORY: Support
    MAIN_MENU --> LANGUAGE_SELECTION: Change Language

    BOOKING_TRIP_TYPE --> BOOKING_PICKUP
    BOOKING_PICKUP --> BOOKING_DROP: not HOURLY
    BOOKING_PICKUP --> BOOKING_DATE: HOURLY
    BOOKING_DROP --> BOOKING_DATE
    BOOKING_DATE --> BOOKING_TIME
    BOOKING_TIME --> BOOKING_RETURN_DATE: ROUND_TRIP
    BOOKING_TIME --> BOOKING_RENTAL_HOURS: HOURLY
    BOOKING_TIME --> BOOKING_PASSENGERS: ONE_WAY / AIRPORT
    BOOKING_RETURN_DATE --> BOOKING_RETURN_TIME
    BOOKING_RETURN_TIME --> BOOKING_PASSENGERS
    BOOKING_RENTAL_HOURS --> BOOKING_PASSENGERS
    BOOKING_PASSENGERS --> BOOKING_VEHICLE_SELECTION
    BOOKING_VEHICLE_SELECTION --> BOOKING_FARE_CONFIRMATION

    BOOKING_FARE_CONFIRMATION --> BOOKING_VEHICLE_SELECTION: Change Vehicle
    BOOKING_FARE_CONFIRMATION --> BOOKING_TRIP_TYPE: Modify Trip
    BOOKING_FARE_CONFIRMATION --> BOOKING_CUSTOMER_NAME: Continue
    BOOKING_FARE_CONFIRMATION --> MAIN_MENU: fare-only enquiry (no booking)

    BOOKING_CUSTOMER_NAME --> BOOKING_REVIEW
    BOOKING_REVIEW --> BOOKING_TRIP_TYPE: Modify
    BOOKING_REVIEW --> MAIN_MENU: Cancel
    BOOKING_REVIEW --> BOOKING_CREATED: Confirm & Pay
    BOOKING_CREATED --> PAYMENT_PENDING

    PAYMENT_PENDING --> BOOKING_CONFIRMED: Razorpay webhook — payment.captured
    PAYMENT_PENDING --> PAYMENT_PENDING: Razorpay webhook — payment.failed (retry offered)
    BOOKING_CONFIRMED --> MAIN_MENU

    MY_BOOKINGS --> BOOKING_DETAILS
    BOOKING_DETAILS --> CANCELLATION_REASON: Cancel Booking
    CANCELLATION_REASON --> CANCELLATION_CONFIRMATION
    CANCELLATION_CONFIRMATION --> MAIN_MENU

    SUPPORT_CATEGORY --> SUPPORT_MESSAGE
    SUPPORT_CATEGORY --> HUMAN_HANDOFF: Talk to Human
    SUPPORT_MESSAGE --> MAIN_MENU

    state "any state" as any
    any --> HUMAN_HANDOFF: unhandled error / explicit request / no vehicles available
    any --> SESSION_EXPIRED: idle > SESSION_TIMEOUT_MINUTES (with in-progress draft)
    SESSION_EXPIRED --> MAIN_MENU: Start New Booking
    SESSION_EXPIRED --> "(previousState)": Continue
```

## Global interrupts

At any state (except `LANGUAGE_SELECTION`), the words `menu`, `cancel`,
`help`, `support`, `human`, `agent` re-route through
`handlers/nluRouter.js:routeFromIntent` regardless of what the current
state was expecting — this is the "interruption handling" behavior
from the spec (a customer typing "how much will it cost?" mid-flow, or
"talk to support" while filling in a date, is never stuck).

## PAYMENT_PENDING is the one state driven by an external event

Every other transition happens because the *customer* sent a message.
`PAYMENT_PENDING → BOOKING_CONFIRMED` (or back to a retry prompt) is
instead driven by the Razorpay webhook (`razorpayWebhook.controller.js`)
or a verified Checkout callback — never by anything the customer types
in chat. See `docs/ARCHITECTURE.md#payment-trust-boundary`.
