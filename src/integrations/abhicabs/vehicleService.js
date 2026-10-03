const env = require('../../config/env');
const { getPrisma } = require('../../config/db');
const backendHttp = require('./backendHttp');

/**
 * getAvailableVehicles Ã¢â‚¬â€ the ONLY source of vehicle data for the bot.
 * The AI/conversation layer must call this rather than ever listing
 * vehicles from memory or training data.
 */
async function getAvailableVehicles({ tripType }) {
  if (env.BACKEND_MODE === 'remote') {
    const { data } = await backendHttp.post('/fares/options', { tripType, availabilityOnly: true });
    return data.vehicles; // shape defined by real backend contract Ã¢â‚¬â€ verify before go-live
  }

  const prisma = getPrisma();
  const vehicles = await prisma.botVehicle.findMany({
    where: { active: true, supportedTripTypes: { has: tripType } },
  });

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
  return prisma.botVehicle.findFirst({ where: { vehicleId, active: true } });
}

module.exports = { getAvailableVehicles, getVehicleById };
