const env = require('../../config/env');
const { getPrisma } = require('../../config/db');
const backendHttp = require('./backendHttp');

/**
 * The vehicle table is called BotVehicle in newer schemas and Vehicle in older
 * ones — use whichever this Prisma client has.
 */
function vehicleModel(prisma) {
  const model = prisma.botVehicle || prisma.vehicle;
  if (!model) throw new Error('No BotVehicle/Vehicle model in prisma/schema.prisma');
  return model;
}

/**
 * supportedTripTypes may be a Json column (["ONE_WAY", ...]), a String[] column,
 * or a JSON string. An empty/missing list means "not restricted" — the vehicle is
 * offered for every trip type rather than silently hidden.
 */
function supportsTripType(vehicle, tripType) {
  let types = vehicle.supportedTripTypes;
  if (typeof types === 'string') {
    try {
      types = JSON.parse(types);
    } catch (e) {
      types = [];
    }
  }
  if (!Array.isArray(types) || types.length === 0) return true;
  return types.map((x) => String(x).toUpperCase()).includes(String(tripType).toUpperCase());
}

/**
 * Active vehicles for a trip type. Filtering is done here in JavaScript rather
 * than with Prisma's `has` filter, which only works on String[] columns and
 * throws "Invalid prisma.botVehicle.findMany() invocation" on a Json column.
 */
async function loadActiveVehicles(tripType) {
  const prisma = getPrisma();
  const all = await vehicleModel(prisma).findMany({ where: { active: true } });
  return tripType ? all.filter((v) => supportsTripType(v, tripType)) : all;
}

/**
 * getAvailableVehicles — the ONLY source of vehicle data for the bot.
 * The AI/conversation layer must call this rather than ever listing
 * vehicles from memory or training data.
 */
async function getAvailableVehicles({ tripType }) {
  if (env.BACKEND_MODE === 'remote') {
    const { data } = await backendHttp.post('/fares/options', { tripType, availabilityOnly: true });
    return data.vehicles; // shape defined by real backend contract — verify before go-live
  }

  const vehicles = await loadActiveVehicles(tripType);

  return vehicles.map((v) => ({
    vehicleId: v.vehicleId,
    name: v.name,
    category: v.category,
    seatingCapacity: v.seatingCapacity,
    ac: v.ac,
  }));
}

async function getVehicleById(vehicleId) {
  if (env.BACKEND_MODE === 'remote') {
    const { data } = await backendHttp.get(`/vehicles/${vehicleId}`);
    return data;
  }
  const prisma = getPrisma();
  return vehicleModel(prisma).findFirst({ where: { vehicleId, active: true } });
}

module.exports = { getAvailableVehicles, getVehicleById, loadActiveVehicles, supportsTripType, vehicleModel };
