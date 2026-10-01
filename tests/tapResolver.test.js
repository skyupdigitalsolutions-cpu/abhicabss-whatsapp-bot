const { rememberMenu, forgetMenu, resolveTap } = require('../src/conversation/numberedMenu');

const NUM = '919000000001';
const categories = [
  { id: 'CAT_SEDAN', title: '1️⃣ Sedan', description: '1 option · from ₹945' },
  { id: 'CAT_SUV', title: '2️⃣ SUV', description: '2 options · from ₹1,200' },
  { id: 'CAT_PREMIUM', title: '3️⃣ Premium', description: '2 options · from ₹1,470' },
];

describe('resolveTap', () => {
  beforeEach(() => {
    forgetMenu(NUM);
    rememberMenu(NUM, categories);
  });

  test.each([
    ['title with number', { text: '1️⃣ Sedan' }, 'CAT_SEDAN'],
    ['title without number', { text: 'Sedan' }, 'CAT_SEDAN'],
    ['lower case', { text: 'suv' }, 'CAT_SUV'],
    ['description only', { text: '2 options · from ₹1,470' }, 'CAT_PREMIUM'],
    ['title and description on two lines', { text: '3️⃣ Premium\n2 options · from ₹1,470' }, 'CAT_PREMIUM'],
    ['the id as text', { text: 'CAT_SUV' }, 'CAT_SUV'],
    ['interactiveTitle only', { interactiveTitle: '1️⃣ Sedan' }, 'CAT_SEDAN'],
    ['id inside the raw event', { text: null, raw: { messages: '[{"list_reply":{"id":"CAT_PREMIUM"}}]' } }, 'CAT_PREMIUM'],
  ])('%s', (_name, message, expected) => {
    expect(resolveTap(NUM, message)).toBe(expected);
  });

  test('an echoed copy of the whole menu in the raw event does not pick a random row', () => {
    const raw = { context: 'CAT_SEDAN CAT_SUV CAT_PREMIUM' };
    expect(resolveTap(NUM, { text: null, raw })).toBeNull();
  });

  test('unrelated text is not a choice', () => {
    expect(resolveTap(NUM, { text: 'hello there' })).toBeNull();
    expect(resolveTap(NUM, { text: '' })).toBeNull();
  });

  test('once a plain message was sent, the menu is forgotten', () => {
    forgetMenu(NUM);
    expect(resolveTap(NUM, { text: 'Sedan' })).toBeNull();
  });

  test('another customer\'s menu is never used', () => {
    expect(resolveTap('919999999999', { text: 'Sedan' })).toBeNull();
  });
});
