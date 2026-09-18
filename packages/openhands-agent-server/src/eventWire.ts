import type { Condensation, Event } from '@smolpaws/openhands-agent';

type WireCondensation = Omit<Condensation, 'forgotten_event_ids'> & { forgotten_event_ids: string[] };

/** Python JSON-mode serialization represents the SDK's forgotten-ID set as an array. */
export function eventForWire(event: Event): Exclude<Event, Condensation> | WireCondensation {
  return event.kind === 'Condensation'
    ? { ...event, forgotten_event_ids: [...event.forgotten_event_ids] }
    : event;
}
