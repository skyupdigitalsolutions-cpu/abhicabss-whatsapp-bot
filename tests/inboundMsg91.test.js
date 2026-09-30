const { normalizeInboundMessage, effectiveText } = require('../src/conversation/inbound');

describe('normalizeInboundMessage (MSG91 format)', () => {
  test('parses a plain text message', () => {
    const payload = {
      customerNumber: '917748847990',
      customerName: 'Manas',
      contentType: 'text',
      text: 'Hi',
      uuid: 'wamid.ABC123',
      ts: '2025-08-25T15:25:55+05:30',
    };
    const result = normalizeInboundMessage(payload);
    expect(result.from).toBe('917748847990');
    expect(result.id).toBe('wamid.ABC123');
    expect(result.type).toBe('text');
    expect(result.text).toBe('Hi');
    expect(result.interactiveId).toBeNull();
  });

  test('parses a quick-reply button tap', () => {
    const payload = {
      customerNumber: '917748847990',
      uuid: 'wamid.XYZ',
      button: JSON.stringify({ payload: 'MENU_BOOK_CAB', text: 'Book a Cab' }),
    };
    const result = normalizeInboundMessage(payload);
    expect(result.interactiveId).toBe('MENU_BOOK_CAB');
    expect(result.interactiveTitle).toBe('Book a Cab');
  });

  test('parses an interactive list_reply', () => {
    const payload = {
      customerNumber: '917748847990',
      uuid: 'wamid.LIST1',
      interactive: JSON.stringify({
        type: 'list_reply',
        list_reply: { id: 'VEHICLE_sedan-dzire', title: 'Swift Dzire A/C' },
      }),
    };
    const result = normalizeInboundMessage(payload);
    expect(result.interactiveId).toBe('VEHICLE_sedan-dzire');
    expect(result.interactiveTitle).toBe('Swift Dzire A/C');
  });

  test('parses an interactive button_reply', () => {
    const payload = {
      customerNumber: '917748847990',
      uuid: 'wamid.BTN1',
      interactive: JSON.stringify({
        type: 'button_reply',
        button_reply: { id: 'FARE_CONTINUE', title: 'Continue' },
      }),
    };
    const result = normalizeInboundMessage(payload);
    expect(result.interactiveId).toBe('FARE_CONTINUE');
    expect(result.interactiveTitle).toBe('Continue');
  });

  test('parses a shared location', () => {
    const payload = {
      customerNumber: '917748847990',
      uuid: 'wamid.LOC1',
      latitude: '22.7252947',
      longitude: '75.8905714',
    };
    const result = normalizeInboundMessage(payload);
    expect(result.type).toBe('location');
    expect(result.location.latitude).toBeCloseTo(22.7252947);
    expect(result.location.longitude).toBeCloseTo(75.8905714);
  });

  test('does not crash on malformed JSON in button/interactive fields', () => {
    const payload = {
      customerNumber: '917748847990',
      uuid: 'wamid.BAD1',
      button: '{not valid json',
      text: 'fallback text',
    };
    const result = normalizeInboundMessage(payload);
    expect(result.text).toBe('fallback text');
  });
});

describe('effectiveText', () => {
  test('prefers interactiveTitle over text when both are present', () => {
    expect(effectiveText({ interactiveTitle: 'Book a Cab', text: 'ignored' })).toBe('Book a Cab');
  });
  test('falls back to text when no interactive title', () => {
    expect(effectiveText({ interactiveTitle: null, text: 'Hi' })).toBe('Hi');
  });
});
