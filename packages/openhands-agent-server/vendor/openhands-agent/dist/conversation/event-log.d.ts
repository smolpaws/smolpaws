import { type Event } from '../event/index.js';
import type { FileStore } from '../io/index.js';
export declare const EVENTS_DIR = "events";
export declare const EVENT_FILE_PATTERN = "event-{idx}-{event_id}.json";
export declare const LOCK_FILE_NAME = ".eventlog.lock";
export declare const LOCK_TIMEOUT_SECONDS = 30;
export declare class DuplicateEventError extends Error {
    constructor(eventId: string, index: number);
}
export declare class EventLog {
    private readonly fs;
    private readonly dir;
    private readonly lockPath;
    private readonly idToIndex;
    private readonly indexToId;
    private readonly eventCache;
    private lengthValue;
    constructor(fs: FileStore, dirPath?: string);
    get length(): number;
    getIndex(eventId: string): number;
    has(eventId: string): boolean;
    getId(index: number): string;
    get(index: number): Event;
    at(index: number): Event | undefined;
    slice(start?: number, end?: number): Event[];
    toArray(): Event[];
    refresh(): void;
    append(event: Event): void;
    appendMultiple(events: readonly Event[]): void;
    appendAsync(event: Event): Promise<void>;
    appendMultipleAsync(events: readonly Event[]): Promise<void>;
    [Symbol.iterator](): Iterator<Event>;
    private normalizeIndex;
    private countEventsOnDisk;
    private syncFromDisk;
    private writeEventsUnderLock;
    private markerPath;
    private markerMatchesLength;
    private advanceLengthMarker;
    private scanAndBuildIndex;
    private pathForIndex;
    private path;
}
