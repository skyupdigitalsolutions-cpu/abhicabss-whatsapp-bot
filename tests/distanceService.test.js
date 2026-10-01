jest.mock('axios', () => ({ get: jest.fn(), create: jest.fn(() => ({ get: jest.fn(), post: jest.fn() })) }));
const axios = require('axios');

function load(key) {
  jest.resetModules();
  process.env.GOOGLE_MAPS_API_KEY = key;
  // axios is re-mocked after resetModules
  jest.doMock('axios', () => ({ get: axios.get, create: axios.create }));
  return require('../src/integrations/abhicabs/distanceService');
}

const googleOk = (meters) => ({ data: { status: 'OK', rows: [{ elements: [{ status: 'OK', distance: { value: meters } }] }] } });

describe('distanceService.resolveDistanceKm', () => {
  beforeEach(() => axios.get.mockReset());

  test('uses Google road distance for typed addresses', async () => {
    axios.get.mockResolvedValue(googleOk(570000));
    const { resolveDistanceKm } = load('test-key');
    const km = await resolveDistanceKm({ address: 'Bangalore Airport' }, { address: 'Hyderabad Charminar' });
    expect(km).toBe(570);
    const call = axios.get.mock.calls[0][1].params;
    expect(call.origins).toBe('Bangalore Airport');
    expect(call.destinations).toBe('Hyderabad Charminar');
    expect(call.key).toBe('test-key');
  });

  test('sends coordinates as "lat,lng" when a location pin was shared', async () => {
    axios.get.mockResolvedValue(googleOk(12000));
    const { resolveDistanceKm } = load('test-key');
    await resolveDistanceKm({ address: 'Pin', latitude: 12.97, longitude: 77.59 }, { address: 'Mysore' });
    expect(axios.get.mock.calls[0][1].params.origins).toBe('12.97,77.59');
  });

  test('falls back to straight-line distance when Google fails and both points have coordinates', async () => {
    axios.get.mockRejectedValue(new Error('network'));
    const { resolveDistanceKm } = load('test-key');
    const km = await resolveDistanceKm({ latitude: 12.97, longitude: 77.59 }, { latitude: 13.08, longitude: 80.27 });
    expect(km).toBeGreaterThan(250);
    expect(km).toBeLessThan(300);
  });

  test('falls back to the 50 km default when there is nothing better', async () => {
    axios.get.mockResolvedValue({ data: { status: 'REQUEST_DENIED', error_message: 'bad key' } });
    const { resolveDistanceKm, DEFAULT_KM } = load('test-key');
    expect(await resolveDistanceKm({ address: 'A' }, { address: 'B' })).toBe(DEFAULT_KM);
  });

  test('does not call Google at all without an API key', async () => {
    const { resolveDistanceKm, DEFAULT_KM } = load('');
    expect(await resolveDistanceKm({ address: 'A' }, { address: 'B' })).toBe(DEFAULT_KM);
    expect(axios.get).not.toHaveBeenCalled();
  });
});
