/**
 * seed-vehicles.js
 * One-time script to populate your local bot_vehicles table with a few
 * real vehicles, matching the Vehicle model in prisma/schema.prisma.
 *
 * Without this, getAvailableVehicles() always returns an empty list for
 * every trip type — which is exactly why the bot said "no vehicles are
 * currently available" and handed off to a human.
 *
 * USAGE:
 *   node seed-vehicles.js
 * (safe to run more than once — uses upsert, won't create duplicates)
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const vehicles = [
  {
    vehicleId: 'MINI_HATCH',
    name: 'Mini Hatchback',
    category: 'SEDAN',
    seatingCapacity: 4,
    ac: true,
    supportedTripTypes: ['ONE_WAY', 'ROUND_TRIP', 'AIRPORT', 'HOURLY'],
    baseFarePerKm: 12,
    baseFarePerHour: 150,
  },
  {
    vehicleId: 'SEDAN_STD',
    name: 'Sedan',
    category: 'SEDAN',
    seatingCapacity: 4,
    ac: true,
    supportedTripTypes: ['ONE_WAY', 'ROUND_TRIP', 'AIRPORT', 'HOURLY'],
    baseFarePerKm: 15,
    baseFarePerHour: 180,
  },
  {
    vehicleId: 'SUV_STD',
    name: 'SUV',
    category: 'SUV',
    seatingCapacity: 6,
    ac: true,
    supportedTripTypes: ['ONE_WAY', 'ROUND_TRIP', 'AIRPORT', 'HOURLY'],
    baseFarePerKm: 20,
    baseFarePerHour: 250,
  },
];

async function main() {
  for (const v of vehicles) {
    await prisma.vehicle.upsert({
      where: { vehicleId: v.vehicleId },
      update: { ...v, active: true },
      create: { ...v, active: true },
    });
    console.log(`Upserted vehicle: ${v.name} (${v.vehicleId})`);
  }
  console.log('Done. Vehicles are now available for booking.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Seeding failed:', err.message);
  process.exit(1);
});