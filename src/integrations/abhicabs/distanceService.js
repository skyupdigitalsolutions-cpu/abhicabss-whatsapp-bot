const axios = require('axios');
const env = require('../../config/env');
const { logger } = require('../../config/logger');

const DEFAULT_KM = 50;

/** Straight-line distance (km) between two points that both have coordinates, else null. */
function haversineKm(a, b) {
  if (a?.latitude == null || b?.latitude == null) return null;
  const R = 6371;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLon = ((b.longitude - a.longitude) * Math.PI) / 180;
  const lat1 = (a.latitude * Math.PI) / 180;
  const lat2 = (b.latitude * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** "lat,lng" when a WhatsApp location pin was shared, otherwise the typed address. */
function placeString(p) {
  if (p?.latitude != null && p?.longitude != null) return `${p.latitude},${p.longitude}`;
  return p?.address || null;
}

/** Driving distance in km from Google Distance Matrix, or null if unavailable. Never logs the API key. */
async function googleRoadKm(pickup, drop) {
  const key = env.GOOGLE_MAPS_API_KEY;
  if (!key) return null;
  const origin = placeString(pickup);
  const destination = placeString(drop);
  if (!origin || !destination) return null;

  try {
    const { data } = await axios.get('https://maps.googleapis.com/maps/api/distancematrix/json', {
      params: { origins: origin, destinations: destination, mode: 'driving', units: 'metric', region: 'in', key },
      timeout: 8000,
    });
    const element = data?.rows?.[0]?.elements?.[0];
    if (data?.status === 'OK' && element?.status === 'OK' && element.distance?.value) {
      return element.distance.value / 1000;
    }
    logger.warn(
      { status: data?.status, elementStatus: element?.status, message: data?.error_message },
      '[distance] Google could not work out the distance'
    );
  } catch (err) {
    logger.error({ err: err.message }, '[distance] Google Distance Matrix request failed');
  }
  return null;
}

/**
 * Road distance used to price a trip:
 *   1. Google Distance Matrix (accurate) when GOOGLE_MAPS_API_KEY is set
 *   2. straight-line distance when both points have coordinates (under-estimates)
 *   3. 50 km default (the old behaviour) — fares are then NOT reliable, so it is logged loudly.
 */
async function resolveDistanceKm(pickup, drop) {
  const road = await googleRoadKm(pickup, drop);
  if (road) return road;

  const straight = haversineKm(pickup, drop);
  if (straight) {
    logger.warn('[distance] using straight-line distance — set GOOGLE_MAPS_API_KEY for road distance');
    return straight;
  }

  logger.warn('[distance] no coordinates and no Google result — using the 50 km default; fares are NOT accurate');
  return DEFAULT_KM;
}

module.exports = { resolveDistanceKm, haversineKm, DEFAULT_KM };
