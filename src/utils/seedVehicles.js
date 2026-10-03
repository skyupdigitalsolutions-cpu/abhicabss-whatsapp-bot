/* eslint-disable no-console */
const { connectDB, disconnectDB, getPrisma } = require('../config/db');

// Placeholder per-km/per-hour rates Ã¢â‚¬â€ replace with ABHI CABS' real
// pricing before go-live. This seed only exists so BACKEND_MODE=local
// has something to quote against; it is NOT the pricing source of
// truth once the real backend/rate card is wired in (BACKEND_MODE=remote).
const VEHICLES = [
  { vehicleId: 'sedan-dzire', name: 'Swift Dzire A/C', category: 'SEDAN', seatingCapacity: 4, baseFarePerKm: 12, baseFarePerHour: 250 },
  { vehicleId: 'suv-ertiga', name: 'Ertiga A/C', category: 'SUV', seatingCapacity: 6, baseFarePerKm: 15, baseFarePerHour: 300 },
  { vehicleId: 'suv-innova', name: 'Innova A/C', category: 'SUV', seatingCapacity: 7, baseFarePerKm: 18, baseFarePerHour: 350 },
  { vehicleId: 'premium-innova-crysta', name: 'Innova Crysta A/C', category: 'PREMIUM', seatingCapacity: 7, baseFarePerKm: 22, baseFarePerHour: 400 },
  { vehicleId: 'premium-hycross', name: 'Innova Hycross A/C', category: 'PREMIUM', seatingCapacity: 7, baseFarePerKm: 24, baseFarePerHour: 420 },
  { vehicleId: 'tempo-12', name: '12 Seater Tempo Traveller', category: 'TEMPO_TRAVELLER', seatingCapacity: 12, baseFarePerKm: 28, baseFarePerHour: 500, supportedTripTypes: ['ONE_WAY', 'ROUND_TRIP', 'AIRPORT', 'HOURLY'] },
  { vehicleId: 'urbania-force', name: 'Force Urbania A/C', category: 'TEMPO_TRAVELLER', seatingCapacity: 16, baseFarePerKm: 32, baseFarePerHour: 600 },
  { vehicleId: 'urbania-16', name: '16 Seater Urbania A/C', category: 'TEMPO_TRAVELLER', seatingCapacity: 16, baseFarePerKm: 32, baseFarePerHour: 600 },
  { vehicleId: 'tempo-17', name: '17 Seater Tempo Traveller A/C', category: 'TEMPO_TRAVELLER', seatingCapacity: 17, baseFarePerKm: 34, baseFarePerHour: 620 },
  { vehicleId: 'urbania-20', name: '20 Seater Urbania A/C', category: 'TEMPO_TRAVELLER', seatingCapacity: 20, baseFarePerKm: 38, baseFarePerHour: 700, supportedTripTypes: ['ONE_WAY', 'ROUND_TRIP', 'AIRPORT'] },
  { vehicleId: 'bus-bharatbenz', name: 'Bharat Benz A/C Bus', category: 'BUS', seatingCapacity: 35, baseFarePerKm: 55, baseFarePerHour: 1200, supportedTripTypes: ['ONE_WAY', 'ROUND_TRIP'] },
  { vehicleId: 'bus-ashokleyland', name: 'Ashok Leyland A/C Bus', category: 'BUS', seatingCapacity: 45, baseFarePerKm: 65, baseFarePerHour: 1400, supportedTripTypes: ['ONE_WAY', 'ROUND_TRIP'] },
];

async function seed() {
  await connectDB();
  const prisma = getPrisma();

  for (const v of VEHICLES) {
    const { vehicleId, ...rest } = v;
    // eslint-disable-next-line no-await-in-loop
    await prisma.botVehicle.upsert({
      where: { vehicleId },
      update: { ...rest, ac: true, driverAllowancePerDay: 300, active: true },
      create: { vehicleId, ...rest, ac: true, driverAllowancePerDay: 300, active: true },
    });
  }

  console.log(`Seeded ${VEHICLES.length} vehicles.`);
  await disconnectDB();
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
