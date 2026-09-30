# API Mapping

This table is the contract `src/integrations/abhicabs/*` targets when
`BACKEND_MODE=remote`. **It has not been verified against any real ABHI
CABS backend source code** (none was provided) — treat every row as a
proposed shape, and correct it against the actual backend before
switching out of local mode.

| Bot Feature | Endpoint | Method | Required Data | Local-mode implementation |
|---|---|---|---|---|
| Vehicle availability | `/fares/options` | POST | `tripType, availabilityOnly` | `vehicleService.getAvailableVehicles` → `Vehicle` collection |
| Fare Options | `/fares/options` | POST | `tripType, pickup, drop, pickupAt, returnAt, rentalHours` | `fareService.getFareOptions` → haversine distance × rate card |
| Fare Estimate | `/fares/estimate` | POST | `fareQuoteId, tripType, pickup, drop, pickupAt, returnAt, rentalHours, vehicleId` | `fareService.estimateFare` → cached quote or recompute |
| Create Booking | `/bookings` | POST (header `Idempotency-Key`) | booking details | `bookingService.createBooking` → `Booking` collection, unique `idempotencyKey` |
| Booking Lookup (by id) | `/bookings/:id` | GET | booking ID | `bookingService.getBookingById` |
| Booking Lookup (by number) | `/bookings/number/:bookingNumber` | GET | booking number | `bookingService.getBookingByNumber` |
| Customer's bookings | `/customers/:id/bookings` | GET | customer ID, `limit` | `bookingService.getBookingsForCustomer` |
| Booking Summary | `/bookings/:id/summary` | GET | booking ID | `bookingService.getBookingSummary` → booking + payment + liveLocation |
| Booking status update | `/bookings/:id/status` | PATCH | `status`, extra fields | `bookingService.updateBookingStatus` |
| Available Actions | `/bookings/:id/actions` | GET | booking ID | `cancellationService.getAvailableActions` |
| Cancellation Quote | `/bookings/:id/cancellation-quote` | GET | booking ID | `cancellationService.getCancellationQuote` → `utils/cancellationPolicy` |
| Cancel Booking | `/bookings/:id/cancel` | POST | `reason` | `cancellationService.cancelBooking` |
| Invoice | `/bookings/:id/invoice` | GET | booking ID | `invoiceService.getInvoice` → `Booking.invoiceUrl` (null if not yet generated) |
| Payment Order | `/payments/orders` | POST (header `Idempotency-Key`) | `bookingId, amount` | `paymentService.createPaymentOrder` → Razorpay `orders.create` |
| Payment Status | `/payments/:id` | GET | payment ID | `paymentService.getPaymentStatus` |
| Support Ticket | `/support/tickets` | POST | customer/booking/category/message | `supportService.createSupportTicket` |

## Payment verification (not a REST call — signature-based)

| Event | Source | Verified by |
|---|---|---|
| Checkout callback | Razorpay Checkout, client-side | `paymentService.verifyAndCapturePayment` — checks `razorpaySignature` against `RAZORPAY_KEY_SECRET`, then double-checks via `razorpayClient.fetchPayment` |
| Webhook | Razorpay servers → `POST /webhook/razorpay` | `razorpayWebhook.controller.js` — checks `X-Razorpay-Signature` against `RAZORPAY_WEBHOOK_SECRET` |

Both paths are required in production: the webhook is the durable
source of truth (fires even if the customer closes the browser/app
mid-checkout), while the Checkout callback gives a faster in-chat
confirmation when available.
