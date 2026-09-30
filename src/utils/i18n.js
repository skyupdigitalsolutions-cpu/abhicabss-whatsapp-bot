const path = require('path');
const fs = require('fs');

const localesDir = path.join(__dirname, '..', 'locales');
const cache = new Map();

const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'kn', label: 'ಕನ್ನಡ' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'te', label: 'తెలుగు' },
  { code: 'ta', label: 'தமிழ்' },
  { code: 'ml', label: 'മലയാളം' },
  { code: 'mr', label: 'मराठी' },
  { code: 'bn', label: 'বাংলা' },
  { code: 'gu', label: 'ગુજરાતી' },
  { code: 'pa', label: 'ਪੰਜਾਬੀ' },
  { code: 'ur', label: 'اردو' },
];

function loadLocale(code) {
  if (cache.has(code)) return cache.get(code);
  const filePath = path.join(localesDir, `${code}.json`);
  let data = {};
  if (fs.existsSync(filePath)) {
    data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }
  cache.set(code, data);
  return data;
}

const englishFallback = loadLocale('en');

/**
 * t(language, key, vars) — every UI string in the bot goes through
 * here. Falls back to English for any key not yet translated in a
 * given language, so partially-translated locales degrade gracefully
 * instead of showing raw keys.
 */
function t(language, key, vars = {}) {
  const locale = loadLocale(language || 'en');
  let template = locale[key] ?? englishFallback[key] ?? key;
  for (const [k, v] of Object.entries(vars)) {
    template = template.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
  }
  return template;
}

module.exports = { t, SUPPORTED_LANGUAGES };
