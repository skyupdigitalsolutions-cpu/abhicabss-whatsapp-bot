/**
 * Converts an MSG91 inbound WhatsApp webhook payload into the same
 * small, predictable shape the state machine and handlers work with,
 * so nothing downstream needs to know about MSG91's payload format.
 *
 * MSG91 sends ONE flat JSON object per inbound event (not Meta's
 * nested entry/changes/value/messages array) — confirmed from MSG91's
 * documented sample payload:
 *
 *   {
 *     "customerNumber": "917748847990",
 *     "customerName": "Manas",
 *     "contentType": "text",
 *     "text": "Hi",
 *     "uuid": "wamid.HBgM...",              // Meta's own message id
 *     "button": "{\"payload\":\"...\",\"text\":\"...\"}",   // quick-reply button taps
 *     "interactive": "{...}",               // list/button interactive replies
 *     "latitude": "...", "longitude": "...",
 *     "messages": "[{...}]",                // raw Meta message array, stringified
 *     ...
 *   }
 *
 * Since MSG91 is a Meta BSP relaying Meta's own webhook events, the
 * "interactive" field is assumed to carry Meta's own interactive-reply
 * shape (button_reply / list_reply) as a JSON string — this mirrors
 * how "button" and "messages" are handled (both documented as
 * stringified JSON). If MSG91's actual field names differ slightly in
 * practice, only this one function needs adjusting — share the exact
 * inbound JSON your webhook logs show and it can be corrected in one pass.
 */
function safeParseJSON(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeInboundMessage(msg91Payload) {
  const base = {
    id: msg91Payload.uuid || msg91Payload.requestId || null,
    from: msg91Payload.customerNumber,
    timestamp: msg91Payload.ts || null,
    type: msg91Payload.contentType || 'text',
    text: null,
    interactiveId: null,
    interactiveTitle: null,
    location: null,
  };

  // Quick-reply button tap: {"payload":"MENU_BOOK_CAB","text":"Book a Cab"}
  const button = safeParseJSON(msg91Payload.button);
  if (button) {
    base.interactiveId = button.payload || button.id || null;
    base.interactiveTitle = button.text || button.title || null;
    return base;
  }

  // Interactive list/button reply (Meta's own nested shape, relayed as-is)
  const interactive = safeParseJSON(msg91Payload.interactive);
  if (interactive) {
    if (interactive.type === 'button_reply' && interactive.button_reply) {
      base.interactiveId = interactive.button_reply.id;
      base.interactiveTitle = interactive.button_reply.title;
    } else if (interactive.type === 'list_reply' && interactive.list_reply) {
      base.interactiveId = interactive.list_reply.id;
      base.interactiveTitle = interactive.list_reply.title;
    }
    if (base.interactiveId) return base;
  }

  // Location share
  if (msg91Payload.latitude && msg91Payload.longitude) {
    base.type = 'location';
    base.location = {
      latitude: parseFloat(msg91Payload.latitude),
      longitude: parseFloat(msg91Payload.longitude),
      name: null,
      address: null,
    };
    return base;
  }

  // Plain text (the common case)
  if (msg91Payload.text) {
    base.type = 'text';
    base.text = String(msg91Payload.text).trim();
    return base;
  }

  return base;
}

/** The single piece of "free text" a handler should reason over, whichever channel it came from. */
function effectiveText(normalized) {
  return normalized.interactiveTitle || normalized.text || '';
}

module.exports = { normalizeInboundMessage, effectiveText };
