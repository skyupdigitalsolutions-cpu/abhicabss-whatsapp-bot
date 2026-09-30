// End-to-end test of the WHOLE ABHI CABS flow through the real code:
//   webhook -> inbound parser -> state machine -> handlers -> fare engine -> payment service -> Razorpay webhook
// Faked: the database (in memory), Google Distance Matrix, Razorpay's servers, and the outgoing MSG91 call.
// Clock frozen at 2026-10-01 01:30 India time (= 2026-09-30 20:00 UTC).
const Real = Date; const FIXED = new Real('2026-09-30T20:00:00Z').getTime();
global.Date = class extends Real { constructor(...a) { if (a.length) super(...a); else super(FIXED); } static now() { return FIXED; } };

const path = require('path'); const Module = require('module'); const crypto = require('crypto');
Object.assign(process.env, {
  NODE_ENV: 'development', MSG91_AUTH_KEY: 'test', MSG91_INTEGRATED_NUMBER: '918096000182', MSG91_WEBHOOK_SECRET: 'x',
  AI_API_KEY: '', BACKEND_API_URL: 'http://localhost', BACKEND_API_KEY: 'x', RAZORPAY_KEY_ID: 'rzp_test', RAZORPAY_KEY_SECRET: 'secret',
  RAZORPAY_WEBHOOK_SECRET: 'whsec', REDIS_URL: 'x', GOOGLE_MAPS_API_KEY: 'test-key', SUPPORT_PHONE: '+91 99999 11111',
});

// ── fake database ──
const VEHICLES = [
  ['sedan-dzire', 'Swift Dzire A/C', 'SEDAN', 4, 12], ['suv-ertiga', 'Ertiga A/C', 'SUV', 6, 15], ['suv-innova', 'Innova A/C', 'SUV', 7, 18],
  ['premium-innova-crysta', 'Innova Crysta A/C', 'PREMIUM', 7, 22], ['premium-hycross', 'Innova Hycross A/C', 'PREMIUM', 7, 24],
  ['tempo-12', '12 Seater Tempo Traveller', 'TEMPO_TRAVELLER', 12, 28], ['urbania-force', 'Force Urbania A/C', 'TEMPO_TRAVELLER', 16, 32],
  ['urbania-16', '16 Seater Urbania A/C', 'TEMPO_TRAVELLER', 16, 32], ['tempo-17', '17 Seater Tempo Traveller A/C', 'TEMPO_TRAVELLER', 17, 34],
  ['urbania-20', '20 Seater Urbania A/C', 'TEMPO_TRAVELLER', 20, 38], ['bus-bharatbenz', 'Bharat Benz A/C Bus', 'BUS', 35, 55], ['bus-ashokleyland', 'Ashok Leyland A/C Bus', 'BUS', 45, 65],
].map(([vehicleId, name, category, seatingCapacity, baseFarePerKm]) => ({ id: vehicleId, vehicleId, name, category, seatingCapacity, ac: true, baseFarePerKm, baseFarePerHour: baseFarePerKm * 20, driverAllowancePerDay: 300, active: true, supportedTripTypes: ['ONE_WAY', 'ROUND_TRIP', 'AIRPORT', 'HOURLY'] }));
const db = { customers: [], sessions: [], processed: [], bookings: [], payments: [] };
let idc = 0; const uid = () => `id${++idc}`;
const dateKeys = ['lastMessageAt', 'lastInteractionAt', 'expiresAt', 'pickupAt', 'returnAt', 'verifiedAt', 'createdAt'];
const clone = (o) => JSON.parse(JSON.stringify(o), (k, v) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v) && dateKeys.includes(k) ? new Real(v) : v));
const uniq = (e) => { const err = new Error('unique'); err.code = 'P2002'; err.meta = { target: [e] }; return err; };
const matchWhere = (row, where) => Object.entries(where).every(([k, v]) => (v && typeof v === 'object' && 'not' in v) ? row[k] !== v.not : row[k] === v);
class FakePrismaClient {
  constructor() {
    const table = (rows, make, uniques = []) => ({
      findUnique: async ({ where, include }) => { const r = rows.find((x) => matchWhere(x, where)); if (!r) return null; const c = clone(r); if (include?.payment && r.paymentId) c.payment = clone(db.payments.find((p) => p.id === r.paymentId)); return c; },
      findMany: async ({ where = {}, take, orderBy } = {}) => { let r = rows.filter((x) => matchWhere(x, where)).map(clone); if (orderBy) r = r.reverse(); return take ? r.slice(0, take) : r; },
      create: async ({ data }) => { const r = make(data); uniques.forEach((u) => { if (r[u] != null && rows.some((x) => x[u] === r[u])) throw uniq(u); }); rows.push(r); return clone(r); },
      update: async ({ where, data }) => { const r = rows.find((x) => matchWhere(x, where)); Object.assign(r, clone(data)); return clone(r); },
      updateMany: async ({ where, data }) => { const m = rows.filter((x) => matchWhere(x, where)); m.forEach((r) => Object.assign(r, clone(data))); return { count: m.length }; },
      count: async ({ where = {} } = {}) => rows.filter((x) => matchWhere(x, where)).length,
    });
    this.customer = table(db.customers, (d) => ({ id: uid(), name: null, email: null, preferredLanguage: 'en', customerType: 'RETAIL', companyName: null, gstNumber: null, lastInteractionAt: new Date(), ...d }));
    this.session = table(db.sessions, (d) => ({ id: uid(), language: null, previousState: null, draft: {}, activeBookingId: null, activePaymentId: null, pendingIdempotencyKey: null, pendingOptionsMap: {}, humanHandoff: false, handoffReason: null, lastMessageAt: new Date(), expiresAt: null, ...d }));
    this.booking = table(db.bookings, (d) => ({ id: uid(), status: 'CREATED', paymentId: null, createdAt: new Date(), ...d }), ['bookingNumber', 'idempotencyKey']);
    this.payment = table(db.payments, (d) => ({ id: uid(), razorpayPaymentId: null, status: 'CREATED', attempt: 1, verifiedAt: null, ...d }), ['razorpayOrderId', 'idempotencyKey']);
    this.vehicle = { findMany: async ({ where }) => VEHICLES.filter((v) => v.active && v.supportedTripTypes.includes(where.supportedTripTypes.has)).map(clone) };
    this.processedMessage = { create: async ({ data }) => { if (db.processed.includes(data.whatsappMessageId)) throw uniq('whatsappMessageId'); db.processed.push(data.whatsappMessageId); } };
  }
  $on() {} async $connect() {} async $disconnect() {}
}

// ── fakes wired in by module name/path ──
const sent = []; const rzpCalls = []; let plinkN = 0; const googleCalls = [];
const fakeAxios = {
  get: async (url, opts) => { googleCalls.push({ url, params: opts.params }); return { data: { status: 'OK', rows: [{ elements: [{ status: 'OK', distance: { value: 570000 } }] }] } }; },
  create: () => ({ get: async () => ({ data: {} }), post: async () => ({ data: {} }), patch: async () => ({ data: {} }), interceptors: { request: { use() {} }, response: { use() {} } } }),
};
class FakeRazorpay {
  constructor(k) { this.k = k; }
  get paymentLink() { return { create: async (p) => { plinkN += 1; rzpCalls.push(p); return { id: `plink_TEST${plinkN}`, short_url: `https://rzp.io/i/test${plinkN}`, status: 'created' }; }, fetch: async (id) => ({ id, short_url: `https://rzp.io/i/${id}` }) }; }
}
const fakes = {
  '@prisma/client': { PrismaClient: FakePrismaClient },
  axios: fakeAxios,
  razorpay: FakeRazorpay,
  [path.resolve('src/integrations/whatsapp/client.js')]: { sendMessage: async (p) => { sent.push(p); return { status: 'success' }; }, markAsRead: async () => null },
  [path.resolve('src/integrations/abhicabs/supportService.js')]: { createSupportTicket: async () => ({ id: 'T1' }) },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  let key = request;
  if (!fakes[request]) { try { key = Module._resolveFilename(request, parent, isMain); } catch (e) { key = request; } }
  if (fakes[key]) return fakes[key];
  return origLoad.apply(this, arguments);
};

const { connectDB } = require('./src/config/db');
const { receiveWebhook } = require('./src/controllers/webhook.controller');
const request = require('supertest'); const app = require('./src/app');

let fail = 0; const check = (label, ok, extra = '') => { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : '\n        ' + extra}`); };
let n = 0;
async function say(number, text, tap) {
  sent.length = 0; n += 1;
  const event = { customerNumber: number, contentType: tap ? 'interactive' : 'text', uuid: `wamid.${n}`, direction: '0' };
  if (tap) event.interactive = JSON.stringify({ type: 'list_reply', list_reply: { id: tap, title: tap } }); else event.text = text;
  await receiveWebhook({ body: event }, { sendStatus() {} });
  return view();
}
const view = () => sent.map((p) => p.type === 'text' ? { kind: 'text', body: p.text.body } : { kind: p.interactive.type, body: p.interactive.body.text, label: p.interactive.action.button, rows: p.interactive.action.sections?.[0]?.rows, buttons: p.interactive.action.buttons?.map((b) => b.reply.title) });
const all = (r) => r.map((x) => x.body).join('\n');
const sess = (num) => db.sessions.find((s) => s.whatsappNumber === num);
async function rzpWebhook(body, { validSig = true } = {}) {
  const raw = JSON.stringify(body);
  const sig = crypto.createHmac('sha256', validSig ? 'whsec' : 'wrong').update(raw).digest('hex');
  sent.length = 0;
  const res = await request(app).post('/webhook/razorpay').set('content-type', 'application/json').set('x-razorpay-signature', sig).send(raw);
  await new Promise((r) => setTimeout(r, 120));
  return { status: res.status, msgs: view() };
}
const paidEvent = (linkId, payId, paise) => ({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: linkId, status: 'paid', amount_paid: paise } }, payment: { entity: { id: payId, amount: paise, status: 'captured', order_id: 'order_x' } } } });

// drive a customer from "Hi" to the booking summary
async function toSummary(num, { time = '10 am', passengers = '2', cat = 'CAT_SEDAN' } = {}) {
  await say(num, 'Hi'); await say(num, null, 'MENU_BOOK_CAB');
  await say(num, 'Bangalore Airport'); await say(num, 'Hyderabad Charminar');
  await say(num, null, 'DATE_2026-10-25'); await say(num, time);
  await say(num, null, cat); await say(num, 'Ravi Kumar');
  return say(num, passengers);
}

(async () => {
  await connectDB();

  console.log('--- Hi -> Welcome -> Select Service ---');
  const A = '919100000001';
  let r = await say(A, 'Hi');
  check('"Hi" gives ONE message: the service menu (no language question)', r.length === 1 && r[0].kind === 'list', JSON.stringify(r.map((x) => x.kind)));
  check('welcome text says ABHI CABS and asks to select a service', /Welcome to ABHI CABS/.test(r[0].body) && /select a service/i.test(r[0].body), r[0].body);
  check('exactly the 4 services: Book a Cab, My Booking, Help, Contact Us', r[0].rows.length === 4 && /Book a Cab/.test(r[0].rows[0].title) && /My Booking/.test(r[0].rows[1].title) && /Help/.test(r[0].rows[2].title) && /Contact Us/.test(r[0].rows[3].title), JSON.stringify(r[0].rows.map((x) => x.title)));
  check('list button reads "Select Service"', r[0].label === 'Select Service', r[0].label);
  check('new customer starts in English on the menu', sess(A).language === 'en' && sess(A).state === 'MAIN_MENU', `${sess(A).language} ${sess(A).state}`);

  console.log('--- Help and Contact Us ---');
  r = await say(A, null, 'MENU_HELP');
  check('Help -> how-to text, then the menu again', r.length === 2 && /How to book/.test(r[0].body) && r[1].kind === 'list', JSON.stringify(r.map((x) => x.kind)));
  r = await say(A, null, 'MENU_CONTACT');
  check('Contact Us -> shows the support phone, then the menu', /\+91 99999 11111/.test(r[0].body) && r[1].kind === 'list', r[0].body);
  r = await say(A, 'help');
  check('typing "help" shows the help text too', /How to book/.test(all(r)), all(r));

  console.log('--- Book a Cab -> Pickup -> Drop -> Date & Time ---');
  r = await say(A, null, 'MENU_BOOK_CAB');
  check('Book a Cab -> asks pickup straight away (no trip-type question)', r.length === 1 && /pick you up/.test(r[0].body), JSON.stringify(r));
  r = await say(A, 'Bangalore Airport');
  check('pickup -> asks drop', /Where are you going/.test(r[0].body), JSON.stringify(r));
  r = await say(A, 'Hyderabad Charminar');
  check('drop -> calendar (tap-to-select dates)', r[0].kind === 'list' && /What date/.test(r[0].body) && r[0].rows[0].title === 'Today' && r[0].rows.length === 10, JSON.stringify(r[0]));
  r = await say(A, null, 'DATE_2026-10-25');
  check('tap a date -> asks the time', /What time/.test(r[0].body), JSON.stringify(r));

  console.log('--- Cab Type (12 vehicles do not fit one list) ---');
  r = await say(A, '10 am');
  check('time -> "Cab Type" list (categories, max 10 rows)', r[r.length - 1].kind === 'list' && /cab type/i.test(r[r.length - 1].body) && r[r.length - 1].rows.length <= 10, JSON.stringify(r[r.length - 1]));
  const cats = r[r.length - 1];
  check('categories: Sedan, SUV, Premium, Tempo Traveller, Bus', cats.rows.length === 5 && /Sedan/.test(cats.rows[0].title) && /Bus/.test(cats.rows[4].title), JSON.stringify(cats.rows.map((x) => x.title)));
  check('cab-type button is short enough for WhatsApp (<=20)', cats.label.length <= 20 && cats.label === 'Select Cab Type', cats.label);
  check('Google was asked for the ROAD distance (typed addresses, not the 50 km default)', googleCalls.length >= 1 && googleCalls[0].params.origins === 'Bangalore Airport' && googleCalls[0].params.destinations === 'Hyderabad Charminar' && googleCalls[0].params.key === 'test-key', JSON.stringify(googleCalls[0]?.params));
  r = await say(A, null, 'CAT_TEMPO_TRAVELLER');
  check('tap Tempo Traveller -> its 5 cabs listed with fares', r[0].kind === 'list' && r[0].rows.length === 5, JSON.stringify(r));
  check('fare uses the 570 km road distance (Tempo 12 seater: (28*570+300)*1.05 = 17,073)', /17,073/.test(r[0].rows[0].description), r[0].rows[0].description);

  console.log('--- Passenger Details -> Booking Summary ---');
  const B = '919100000002';
  r = await toSummary(B);
  check('Sedan has one cab -> picked straight away, then name + passenger questions, then the summary', r.length === 1 && r[0].kind === 'button', JSON.stringify(r));
  const sum = r[0].body;
  check('summary shows passenger, pickup, drop, date, time (India time), cab, fare', /Ravi Kumar/.test(sum) && /Bangalore Airport/.test(sum) && /Hyderabad Charminar/.test(sum) && /25 Oct 2026/.test(sum) && /10:00 AM/.test(sum) && /Swift Dzire/.test(sum) && /₹7,497/.test(sum), sum);
  check('summary buttons: Confirm Booking / Modify / Cancel', r[0].buttons.length === 3 && /Confirm Booking/.test(r[0].buttons[0]), JSON.stringify(r[0].buttons));
  r = await say(B, 'hello there');
  check('random text does NOT confirm a booking (summary is shown again)', r[0].kind === 'button' && db.bookings.length === 0, `${JSON.stringify(r.map((x) => x.kind))} bookings=${db.bookings.length}`);

  console.log('--- Confirm Booking -> Select Payment Option ---');
  r = await say(B, null, 'REVIEW_CONFIRM');
  check('Confirm -> booking saved', db.bookings.length === 1 && /^ABHI\d{6}$/.test(db.bookings[0].bookingNumber), JSON.stringify(db.bookings[0]?.bookingNumber));
  check('payment options: ₹0 - Pay Later / Partial Payment / Full Payment', r[0].kind === 'button' && r[0].buttons.length === 3 && /Pay Later/.test(r[0].buttons[0]) && /Partial Payment/.test(r[0].buttons[1]) && /Full Payment/.test(r[0].buttons[2]), JSON.stringify(r[0]?.buttons));
  check('button titles fit WhatsApp (<=20 chars)', r[0].buttons.every((t) => t.length <= 20), JSON.stringify(r[0].buttons));
  check('options show the amounts: ₹0 now / ₹1,874 (25%) / ₹7,497', /₹0 now/.test(r[0].body) && /₹1,874 now \(25%\)/.test(r[0].body) && /₹7,497 now/.test(r[0].body), r[0].body);
  check('session waits on the payment choice', sess(B).state === 'BOOKING_CREATED', sess(B).state);
  const bookingB = db.bookings[0];

  console.log('--- Pay Later (₹0) ---');
  r = await say(B, null, 'PAY_LATER');
  check('Pay Later -> Booking Confirmed with full details', /Booking Confirmed/.test(r[0].body) && r[0].body.includes(bookingB.bookingNumber) && /25 Oct 2026/.test(r[0].body) && /10:00 AM/.test(r[0].body) && /Swift Dzire/.test(r[0].body), r[0].body);
  check('Pay Later -> says nothing paid, ₹7,497 due', /No payment has been taken yet\. Amount due: ₹7,497/.test(r[0].body), r[0].body);
  check('booking is CONFIRMED in the database with pay-later recorded', db.bookings[0].status === 'CONFIRMED' && db.bookings[0].fare.paymentMode === 'PAY_LATER' && db.bookings[0].fare.amountDue === 7497, JSON.stringify(db.bookings[0].fare));
  check('no Razorpay link was created for Pay Later', rzpCalls.length === 0);
  check('customer is back on the main menu', sess(B).state === 'MAIN_MENU');
  r = await say(B, null, 'MENU_MY_BOOKING');
  check('My Booking lists the booking with the correct (India) date', r[0].kind === 'list' && r[0].rows[0].description.includes('25 Oct') && r[0].rows[0].title.includes(bookingB.bookingNumber), JSON.stringify(r[0]));

  console.log('--- Partial Payment -> Razorpay -> Verify -> Confirmed + receipt ---');
  const C = '919100000003';
  await toSummary(C); r = await say(C, null, 'REVIEW_CONFIRM');
  const bookingC = db.bookings[1];
  r = await say(C, null, 'PAY_PARTIAL');
  check('Partial -> customer receives a Razorpay payment link for ₹1,874', r.length === 1 && /₹1,874/.test(r[0].body) && r[0].body.includes('https://rzp.io/i/test1'), JSON.stringify(r));
  check('link request to Razorpay: 187400 paise, INR, reference = booking number, +91 contact, 24h expiry', rzpCalls[0].amount === 187400 && rzpCalls[0].currency === 'INR' && rzpCalls[0].reference_id === `${bookingC.bookingNumber}-1` && rzpCalls[0].customer.contact === '+919100000003' && rzpCalls[0].accept_partial === false && rzpCalls[0].expire_by === Math.floor(FIXED / 1000) + 86400, JSON.stringify(rzpCalls[0]));
  check('booking is PAYMENT_PENDING (NOT confirmed) until Razorpay confirms', db.bookings[1].status === 'PAYMENT_PENDING' && db.bookings[1].fare.paymentMode === 'PARTIAL' && sess(C).state === 'PAYMENT_PENDING', `${db.bookings[1].status} ${sess(C).state}`);
  r = await say(C, 'I have paid');
  check('customer saying "I paid" does NOT confirm anything', db.bookings[1].status === 'PAYMENT_PENDING' && /verified/i.test(all(r)), all(r));
  let w = await rzpWebhook(paidEvent('plink_TEST1', 'pay_TEST1', 187400), { validSig: false });
  check('Razorpay webhook with a WRONG signature is rejected (401) and changes nothing', w.status === 401 && db.bookings[1].status === 'PAYMENT_PENDING' && w.msgs.length === 0, `${w.status} ${db.bookings[1].status}`);
  w = await rzpWebhook(paidEvent('plink_TEST1', 'pay_TEST1', 187400));
  check('verified "payment_link.paid" -> booking CONFIRMED', w.status === 200 && db.bookings[1].status === 'CONFIRMED', `${w.status} ${db.bookings[1].status}`);
  const conf = all(w.msgs);
  check('customer gets Booking Confirmed + booking details', /Payment Successful/.test(conf) && /Booking Confirmed/.test(conf) && conf.includes(bookingC.bookingNumber) && /Bangalore Airport/.test(conf) && /25 Oct 2026/.test(conf) && /10:00 AM/.test(conf), conf);
  check('customer gets a payment RECEIPT (receipt no, date, amount, balance, payment id)', new RegExp(`RCPT-${bookingC.bookingNumber}-1`).test(conf) && /Amount paid: ₹1,874 \(Partial payment\)/.test(conf) && /Balance due: ₹5,623/.test(conf) && /Payment ID: pay_TEST1/.test(conf) && /01 Oct 2026, 1:30 AM/.test(conf), conf);
  check('database: amount paid 1,874, due 5,623, payment CAPTURED', db.bookings[1].fare.amountPaid === 1874 && db.bookings[1].fare.amountDue === 5623 && db.payments[0].status === 'CAPTURED' && db.payments[0].razorpayPaymentId === 'pay_TEST1', JSON.stringify([db.bookings[1].fare, db.payments[0]]));
  check('customer is back on the main menu', sess(C).state === 'MAIN_MENU', sess(C).state);
  w = await rzpWebhook(paidEvent('plink_TEST1', 'pay_TEST1', 187400));
  check('Razorpay delivering the same event twice does NOT send a second confirmation', w.status === 200 && w.msgs.length === 0, JSON.stringify(w.msgs));

  console.log('--- Full Payment ---');
  const D = '919100000004';
  await toSummary(D); await say(D, null, 'REVIEW_CONFIRM');
  r = await say(D, null, 'PAY_FULL');
  check('Full -> link for the whole ₹7,497', /₹7,497/.test(r[0].body) && rzpCalls[1].amount === 749700, JSON.stringify([r[0]?.body, rzpCalls[1]?.amount]));
  w = await rzpWebhook(paidEvent('plink_TEST2', 'pay_TEST2', 749700));
  check('Full payment receipt says fully paid, no balance', /Amount paid: ₹7,497 \(Full payment\)/.test(all(w.msgs)) && /Fully paid/.test(all(w.msgs)) && db.bookings[2].fare.amountDue === 0 && db.bookings[2].status === 'CONFIRMED', all(w.msgs));

  console.log('--- retry and expiry ---');
  const E = '919100000005';
  await toSummary(E); await say(E, null, 'REVIEW_CONFIRM'); await say(E, null, 'PAY_FULL');
  r = await say(E, 'retry');
  check('"retry" sends a NEW payment link (attempt 2)', r.length === 1 && r[0].body.includes('https://rzp.io/i/test4') && db.payments.filter((p) => p.bookingId === db.bookings[3].id).length === 2, JSON.stringify(r));
  w = await rzpWebhook({ event: 'payment_link.expired', payload: { payment_link: { entity: { id: 'plink_TEST4', status: 'expired' } } } });
  check('expired link -> customer told, offered Retry / Change / Contact Support', /expired/.test(all(w.msgs)) && w.msgs.some((m) => m.kind === 'button' && m.buttons.length === 3), JSON.stringify(w.msgs));
  check('expired payment is marked TIMEOUT and the booking stays unconfirmed', db.payments.find((p) => p.razorpayOrderId === 'plink_TEST4').status === 'TIMEOUT' && db.bookings[3].status === 'PAYMENT_PENDING');
  r = await say(E, null, 'PAYMENT_CHANGE_METHOD');
  check('"Change payment method" shows the three options again', r[0].kind === 'button' && /Pay Later/.test(r[0].buttons[0]), JSON.stringify(r));

  console.log('--- group bigger than the cab ---');
  const F = '919100000006';
  r = await toSummary(F, { passengers: '6' });
  check('6 passengers in a 4-seat Sedan -> told it is too small, only cabs with 6+ seats offered', r.some((x) => /seats up to 4/.test(x.body)) && r[r.length - 1].kind === 'list', JSON.stringify(r.map((x) => x.body)));
  const offered = r[r.length - 1];
  check('only bigger cabs are offered (category list without Sedan)', offered.rows.length >= 1 && !offered.rows.some((x) => /Sedan/.test(x.title)), JSON.stringify(offered.rows.map((x) => x.title)));
  r = await say(F, null, offered.rows[0].id);
  r = r.length && r[r.length - 1].kind === 'list' ? await say(F, null, r[r.length - 1].rows[0].id) : r;
  check('after choosing a bigger cab the booking summary comes straight back (no re-asking name/count)', r[0].kind === 'button' && /Ravi Kumar/.test(r[0].body) && /6 passengers/.test(r[0].body), JSON.stringify(r));

  console.log('--- early-morning pickup shows the right day (server clock is UTC) ---');
  const G = '919100000007';
  r = await toSummary(G, { time: '1 am' });
  check('1:00 AM on 25 Oct is shown as 25 Oct 1:00 AM (not 24 Oct)', /25 Oct 2026/.test(r[0].body) && /1:00 AM/.test(r[0].body), r[0].body);

  console.log('--- typing instead of tapping, and escaping ---');
  const H = '919100000008';
  await say(H, 'Hi');
  r = await say(H, 'book a cab');
  check('typing "book a cab" starts a booking', /pick you up/.test(all(r)), all(r));
  r = await say(H, 'Mysore');
  r = await say(H, 'menu');
  check('typing "menu" mid-booking returns to the services menu and clears the draft', r[0].kind === 'list' && sess(H).state === 'MAIN_MENU' && !sess(H).draft.pickup?.address, JSON.stringify([r.map((x) => x.kind), sess(H).state]));
  r = await say(H, 'asdfgh qwerty');
  check('unknown text -> "didn\'t understand" + menu (not a scary support message)', /didn't understand/.test(all(r)) && r[r.length - 1].kind === 'list' && !/connect you with our support/.test(all(r)), all(r));
  await say(H, null, 'MENU_BOOK_CAB'); await say(H, 'Mysore'); await say(H, 'Chennai');
  r = await say(H, 'Hi');
  check('"Hi" at any step goes back to the welcome menu', /Welcome to ABHI CABS/.test(all(r)) && sess(H).state === 'MAIN_MENU', all(r));

  console.log('--- a support handoff can always be left with "Hi" ---');
  Object.assign(sess(H), { state: 'HUMAN_HANDOFF', humanHandoff: true });
  r = await say(H, 'need help'); check('other text in handoff stays silent', r.length === 0, JSON.stringify(r));
  r = await say(H, 'Hi'); check('"Hi" releases the chat', r[0].kind === 'list' && sess(H).humanHandoff === false, JSON.stringify(r));

  console.log('--- full HTTP stack ---');
  let res = await request(app).get('/webhook/whatsapp');
  check('browser check shows the build tag', res.status === 200 && /build: /.test(res.text), res.text);
  res = await request(app).post('/webhook/whatsapp').send({ customerNumber: '919100000009', contentType: 'text', text: 'Hi', uuid: 'http-no-secret' });
  check('MSG91 webhook without the secret header -> 401', res.status === 401, String(res.status));
  sent.length = 0;
  res = await request(app).post('/webhook/whatsapp').set('x-webhook-secret', 'x').set('x-forwarded-for', '34.100.132.154, 152.233.15.120').send({ customerNumber: '919100000009', contentType: 'text', text: 'Hi', uuid: 'http-ok' });
  await new Promise((r2) => setTimeout(r2, 200));
  check('MSG91 webhook with the secret -> 200 and the bot replies with the menu', res.status === 200 && sent.length === 1 && sent[0].interactive.type === 'list', `${res.status} ${sent.length}`);

  console.log(fail ? `\n${fail} FAILED` : '\nAll passed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
