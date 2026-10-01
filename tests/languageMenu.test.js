const fs = require('fs');
const path = require('path');
const { AVAILABLE_LANGUAGES } = require('../src/utils/i18n');

describe('language menu', () => {
  test('fits the WhatsApp list limit of 10 rows (11 rows made every new customer get handed to support)', () => {
    expect(AVAILABLE_LANGUAGES.length).toBeGreaterThan(0);
    expect(AVAILABLE_LANGUAGES.length).toBeLessThanOrEqual(10);
  });

  test('English is always offered', () => {
    expect(AVAILABLE_LANGUAGES.some((l) => l.code === 'en')).toBe(true);
  });

  test('every offered language has a translation file', () => {
    for (const l of AVAILABLE_LANGUAGES) {
      const file = path.join(__dirname, '..', 'src', 'locales', `${l.code}.json`);
      expect(fs.existsSync(file)).toBe(true);
    }
  });
});
