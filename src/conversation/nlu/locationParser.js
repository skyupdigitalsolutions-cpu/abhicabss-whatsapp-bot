const axios = require('axios');
const env = require('../../config/env');
const { logger } = require('../../config/logger');

/**
 * Builds a normalized location object from either:
 *   - a WhatsApp "location" message (has real lat/long), or
 *   - typed free text (address only — lat/long left null; we never
 *     guess coordinates for a typed address without a geocoding call).
 *
 * If the typed text is too short/ambiguous (e.g. just "airport" with
 * multiple airports in the service area), the handler layer is
 * expected to ask a clarifying question rather than pick one.
 */
function fromWhatsAppLocationMessage(locationMessage) {
  return {
    address: locationMessage.name || locationMessage.address || null,
    latitude: locationMessage.latitude ?? null,
    longitude: locationMessage.longitude ?? null,
  };
}

function fromTypedText(text) {
  return {
    address: text.trim(),
    latitude: null,
    longitude: null,
  };
}

/** Google Maps link for a pin — always works, even without an API key. */
function mapsLink(lat, lng) {
  return `https://maps.google.com/?q=${lat},${lng}`;
}

/**
 * Readable address for a shared pin via Google Geocoding (uses GOOGLE_MAPS_API_KEY;
 * the Geocoding API must be enabled for that key). Falls back to a Maps link.
 */
async function reverseGeocode(lat, lng) {
  if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) return null;
  const fallback = `Shared location (${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}) ${mapsLink(lat, lng)}`;
  if (!env.GOOGLE_MAPS_API_KEY) return fallback;
  try {
    const { data } = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: { latlng: `${lat},${lng}`, key: env.GOOGLE_MAPS_API_KEY, region: 'in' },
      timeout: 6000,
    });
    const address = data?.status === 'OK' ? data.results?.[0]?.formatted_address : null;
    if (address) return address;
    logger.warn({ status: data?.status, message: data?.error_message }, '[location] reverse geocode gave no address');
  } catch (err) {
    logger.error({ err: err.message }, '[location] reverse geocode failed');
  }
  return fallback;
}

/**
 * True when we can't tell where the customer means. Accepts a location object
 * or a plain address. A shared pin (with coordinates) is never ambiguous.
 */
function isAmbiguous(locationOrAddress) {
  if (locationOrAddress && typeof locationOrAddress === 'object') {
    if (locationOrAddress.latitude != null && locationOrAddress.longitude != null) return false;
    return isAmbiguous(locationOrAddress.address);
  }
  const address = locationOrAddress;
  if (!address) return true;
  const tooShort = address.trim().length < 3;
  const genericOnly = /^(airport|station|home|office)$/i.test(address.trim());
  return tooShort || genericOnly;
}

module.exports = { fromWhatsAppLocationMessage, fromTypedText, isAmbiguous, reverseGeocode, mapsLink };
