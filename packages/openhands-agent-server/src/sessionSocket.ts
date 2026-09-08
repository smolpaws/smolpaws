import { EventLog, messageSchema, type Event, type StreamingDeltaEvent } from '@smolpaws/openhands-agent';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { AgentServerConfig } from './config.js';
import type { ConversationService } from './conversationService.js';
import type { EventService } from './eventService.js';
import type { Subscriber } from './pubSub.js';
import {
  MAX_FRAME_BYTES,
  MAX_PENDING_BYTES,
  serializeSessionFrame,
  type DurableFrame,
  type ErrorFrame,
  type SessionFrame,
  type SyncFrame,
  type TransientFrame,
} from './sessionProtocol.js';
import {
  authenticateSocket,
  bufferToString,
  isAuthControlMessage,
  isSocketConnected,
  safeCloseSocket,
  type SocketLike,
} from './sockets.js';

const REPLAY_PAGE_SIZE = 100;

/**
 * `/sockets/session/{conversation_id}` — the session socket.
 *
 * Fixes three things the legacy `/sockets/events/{id}` endpoint gets wrong,
 * without touching it: frames are envelopes rather than the disk record; history
 * and live traffic cannot interleave; and a slow consumer cannot wedge the
 * publisher, because admission is byte-bounded and only this connection's writer
 * task awaits the socket.
 *
 * `ItemStarted` / `Delta` / `ItemAborted` are carried but never produced yet —
 * that needs `StreamContext` (#4682). Until then this is a durable-only channel
 * and `StreamingDeltaEvent` is dropped rather than forwarded, since putting it
 * back on the wire would restore the coupling this endpoint removes.
 */

export interface SessionSocketDeps {
  readonly config: AgentServerConfig;
  readonly conversationService: ConversationService;
}

export function registerSessionSocket(app: FastifyInstance, deps: SessionSocketDeps): void {
  app.get('/sockets/session/:conversation_id', { websocket: true }, (socket, request) => {
    void handleSessionSocket(socket as SocketLike, request, deps.config, deps.conversationService);
  });
}

async function handleSessionSocket(
  socket: SocketLike,
  request: FastifyRequest,
  config: AgentServerConfig,
  conversationService: ConversationService,
): Promise<void> {
  if (!(await authenticateSocket(socket, request, config))) {
    return;
  }

  const conversationId = (request.params as { conversation_id?: string }).conversation_id;
  if (conversationId === undefined) {
    safeCloseSocket(socket, 4004, 'Conversation not found');
    return;
  }

  const eventService = await conversationService.getEventService(conversationId);
  if (eventService === null) {
    safeCloseSocket(socket, 4004, 'Conversation not found');
    return;
  }

  const eventLog = eventService.state.eventLog;
  if (eventLog === null) {
    safeCloseSocket(socket, 1011, 'session_socket_no_event_log');
    return;
  }

  const writer = new ConnectionWriter(socket);
  writer.start();
  const subscriber = new SessionSubscriber(writer, eventLog);

  const subscriberId = await eventService.subscribeToEvents(subscriber.onEvent);
  try {
    const length = eventLog.length;
    const afterSeq = readAfterSeq(request);
    const throughSeq = length > 0 ? length - 1 : null;

    if (!writer.send({ type: 'sync', from_seq: afterSeq, through_seq: throughSeq } satisfies SyncFrame)) {
      return;
    }

    let replayed = false;
    if (afterSeq !== null && throughSeq !== null) {
      const start = Math.max(afterSeq + 1, 0);
      if (!(await replay(eventLog, start, throughSeq + 1, writer))) return;
      replayed = true;
    }

    subscriber.goLive(replayed ? throughSeq : null);

    await inboundLoop(socket, eventService, writer);
  } finally {
    await eventService.unsubscribeFromEvents(subscriberId);
    await writer.aclose();
    if (writer.dropReason === 'slow_consumer' || writer.dropReason === 'frame_too_large') {
      safeCloseSocket(socket, 1013, writer.dropReason);
    }
  }
}

class ConnectionWriter {
  private dropReasonValue: string | null = null;
  private closed = false;
  private readonly queue: Array<readonly [string, number]> = [];
  private pendingBytes = 0;
  private wake: (() => void) | null = null;
  private task: Promise<void> | null = null;

  constructor(private readonly socket: SocketLike) {}

  get dropReason(): string | null {
    return this.dropReasonValue;
  }

  start(): void {
    this.task = this.run();
  }

  send(frame: SessionFrame): boolean {
    if (this.closed) return false;
    const payload = serializeSessionFrame(frame);
    const size = Buffer.byteLength(payload, 'utf8');
    if (size > MAX_FRAME_BYTES) {
      this.fail('frame_too_large');
      return false;
    }
    if (this.pendingBytes + size > MAX_PENDING_BYTES) {
      this.fail('slow_consumer');
      return false;
    }
    this.queue.push([payload, size]);
    this.pendingBytes += size;
    this.wake?.();
    return true;
  }

  private fail(reason: string): void {
    if (!this.closed) {
      this.dropReasonValue = reason;
      this.closed = true;
    }
    this.wake?.();
  }

  private async run(): Promise<void> {
    while (!this.closed) {
      await new Promise<void>((resolve) => { this.wake = resolve; });
      this.wake = null;
      while (this.queue.length > 0) {
        if (this.closed) return;
        const [payload, size] = this.queue.shift() as readonly [string, number];
        this.pendingBytes -= size;
        if (!isSocketConnected(this.socket)) {
          this.fail('disconnected');
          return;
        }
        try {
          this.socket.send(payload);
        } catch {
          this.fail('writer_error');
          return;
        }
      }
    }
  }

  async aclose(): Promise<void> {
    this.fail('closing');
    await this.task;
  }
}

class SessionSubscriber {
  private buffer: Event[] | null = [];

  constructor(
    private readonly writer: ConnectionWriter,
    private readonly eventLog: EventLog,
  ) {}

  readonly onEvent: Subscriber<Event> = (event: Event) => {
    if (isStreamingDeltaEvent(event)) {
      // Deltas never ride the durable channel; progress frames will come from
      // StreamContext instead.
      return;
    }
    if (this.buffer !== null) {
      this.buffer.push(event);
      return;
    }
    this.emit(event);
  };

  goLive(throughSeq: number | null): void {
    const buffered = this.buffer ?? [];
    this.buffer = null;
    for (const event of buffered) {
      const seq = this.seqOf(event);
      if (seq !== null && throughSeq !== null && seq <= throughSeq) {
        continue; // already sent from disk during replay
      }
      this.emit(event);
    }
  }

  private emit(event: Event): void {
    const seq = this.seqOf(event);
    const frame: SessionFrame = seq === null
      ? { type: 'transient', event } satisfies TransientFrame
      : { type: 'durable', seq, event } satisfies DurableFrame;
    this.writer.send(frame);
  }

  private seqOf(event: Event): number | null {
    try {
      return this.eventLog.getIndex(event.id);
    } catch {
      return null;
    }
  }
}

async function replay(eventLog: EventLog, start: number, stop: number, writer: ConnectionWriter): Promise<boolean> {
  for (let pageStart = start; pageStart < stop; pageStart += REPLAY_PAGE_SIZE) {
    const pageStop = Math.min(pageStart + REPLAY_PAGE_SIZE, stop);
    for (let seq = pageStart; seq < pageStop; seq += 1) {
      const event = tryReadEvent(eventLog, seq);
      if (event === null) continue;
      if (!writer.send({ type: 'durable', seq, event } satisfies DurableFrame)) return false;
      // Yield so a page of large events cannot starve the writer task.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return true;
}

async function inboundLoop(socket: SocketLike, eventService: EventService, writer: ConnectionWriter): Promise<void> {
  await new Promise<void>((resolve) => {
    const onMessage = (data: unknown): void => {
      let payload: unknown;
      try {
        payload = JSON.parse(bufferToString(data)) as unknown;
      } catch (error) {
        writer.send({ type: 'error', code: error instanceof Error ? error.name : 'JSONDecodeError', detail: error instanceof Error ? error.message : String(error) } satisfies ErrorFrame);
        return;
      }
      if (isAuthControlMessage(payload)) return;

      try {
        const message = messageSchema.parse(payload);
        void eventService.sendMessage(message, true).catch((error: unknown) => {
          writer.send({ type: 'error', code: error instanceof Error ? error.name : 'Error', detail: error instanceof Error ? error.message : String(error) } satisfies ErrorFrame);
        });
      } catch (error) {
        writer.send({ type: 'error', code: error instanceof Error ? error.name : 'ValidationError', detail: error instanceof Error ? error.message : String(error) } satisfies ErrorFrame);
      }
    };
    const onClose = (): void => { resolve(); };
    socket.on('message', onMessage);
    socket.on('close', onClose);
    socket.on('error', onClose);
  });
}

function readAfterSeq(request: FastifyRequest): number | null {
  const raw = (request.query as Record<string, unknown>).after_seq;
  if (typeof raw === 'string') {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) return parsed;
    return null;
  }
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
  return null;
}

function tryReadEvent(eventLog: EventLog, index: number): Event | null {
  try {
    return eventLog.get(index);
  } catch {
    return null;
  }
}

function isStreamingDeltaEvent(event: Event): event is StreamingDeltaEvent {
  return event.kind === 'StreamingDeltaEvent';
}