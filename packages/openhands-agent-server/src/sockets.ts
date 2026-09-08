import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { BashEventService } from './bashService.js';
import type { AgentServerConfig } from './config.js';
import type { ConversationService } from './conversationService.js';
import { bashErrorSchema, executeBashRequestSchema, messageFromSendRequest, sendMessageRequestSchema, type BashEvent, type Event } from './models.js';
import type { Subscriber } from './pubSub.js';

const OPEN_SOCKET_STATE = 1;

export interface SocketRouteDeps {
  readonly config: AgentServerConfig;
  readonly conversationService: ConversationService;
  readonly bashEventService: BashEventService;
}

export function registerSocketRoutes(app: FastifyInstance, deps: SocketRouteDeps): void {
  app.get('/sockets/events/:conversation_id', { websocket: true }, (socket, request) => {
    void handleEventsSocket(socket as SocketLike, request, deps);
  });
  app.get('/sockets/bash-events', { websocket: true }, (socket, request) => {
    void handleBashEventsSocket(socket as SocketLike, request, deps);
  });
}

async function handleEventsSocket(socket: SocketLike, request: FastifyRequest, deps: SocketRouteDeps): Promise<void> {
  if (!(await authenticateSocket(socket, request, deps.config))) {
    return;
  }

  const conversationId = (request.params as { conversation_id?: string }).conversation_id;
  if (conversationId === undefined) {
    socket.close(4004, 'Conversation not found');
    return;
  }
  const eventService = await deps.conversationService.getEventService(conversationId);
  if (eventService === null) {
    socket.close(4004, 'Conversation not found');
    return;
  }

  // The live socket is what token streaming is for (upstream sockets.py sets
  // `receives_streaming_deltas = True` on its WebSocket subscriber). The stored
  // function carries the opt-in field so EventService's PubSub keeps fanning
  // `StreamingDeltaEvent`s out to this (and only this) subscriber.
  const sendEvent = (event: Event): void => {
    if (socket.readyState === OPEN_SOCKET_STATE) socket.send(JSON.stringify(event));
  };
  const subscriber: Subscriber<Event> = sendEvent;
  subscriber.receivesStreamingDeltas = true;
  const subscriberId = await eventService.subscribeToEvents(subscriber);
  const query = request.query as Record<string, unknown>;
  const resendMode = typeof query.resend_mode === 'string' ? query.resend_mode : null;
  const resendAll = query.resend_all === 'true' || query.resend_all === true;
  eventService.state.syncFromDisk();
  const events = eventService.state.events;
  if (resendMode === 'all' || (resendMode === null && resendAll)) {
    for (const event of events) sendEvent(event);
  } else if (resendMode === 'since' && typeof query.after_timestamp === 'string') {
    const after = Date.parse(query.after_timestamp);
    for (const event of events) {
      if (Date.parse(event.timestamp) >= after) sendEvent(event);
    }
  }

  socket.on('message', (data: unknown) => {
    void (async () => {
      const payload = JSON.parse(bufferToString(data)) as unknown;
      const requestBody = sendMessageRequestSchema.parse(payload);
      await eventService.sendMessage(messageFromSendRequest(requestBody), requestBody.run, requestBody.event_id);
    })().catch((error: unknown) => {
      if (socket.readyState === OPEN_SOCKET_STATE) socket.send(JSON.stringify({ kind: 'ServerErrorEvent', code: 'WebSocketMessageError', detail: error instanceof Error ? error.message : String(error) }));
    });
  });
  socket.on('close', () => void eventService.unsubscribeFromEvents(subscriberId));
  socket.on('error', () => void eventService.unsubscribeFromEvents(subscriberId));
}

async function handleBashEventsSocket(socket: SocketLike, request: FastifyRequest, deps: SocketRouteDeps): Promise<void> {
  if (!(await authenticateSocket(socket, request, deps.config))) {
    return;
  }

  const sendEvent = (event: BashEvent): void => {
    if (socket.readyState === OPEN_SOCKET_STATE) socket.send(JSON.stringify(event));
  };
  const subscriberId = await deps.bashEventService.subscribeToEvents(sendEvent);
  const query = request.query as Record<string, unknown>;
  const resendMode = typeof query.resend_mode === 'string' ? query.resend_mode : null;
  const resendAll = query.resend_all === 'true' || query.resend_all === true;
  if (resendMode === 'all' || (resendMode === null && resendAll)) {
    const page = await deps.bashEventService.searchBashEvents({ limit: 100 });
    for (const event of page.items) sendEvent(event);
  }

  socket.on('message', (data: unknown) => {
    void (async () => {
      const payload = JSON.parse(bufferToString(data)) as unknown;
      const requestBody = executeBashRequestSchema.parse(payload);
      await deps.bashEventService.startBashCommand(requestBody);
    })().catch((error: unknown) => {
      const errorEvent = bashErrorSchema.parse({ id: randomUUID(), timestamp: new Date().toISOString(), code: error instanceof Error ? error.name : 'WebSocketMessageError', detail: error instanceof Error ? error.message : String(error) });
      if (socket.readyState === OPEN_SOCKET_STATE) socket.send(JSON.stringify(errorEvent));
    });
  });
  socket.on('close', () => void deps.bashEventService.unsubscribeFromEvents(subscriberId));
  socket.on('error', () => void deps.bashEventService.unsubscribeFromEvents(subscriberId));
}

export async function authenticateSocket(socket: SocketLike, request: FastifyRequest, config: AgentServerConfig): Promise<boolean> {
  const expected = config.sessionApiKey;
  if (expected === undefined || expected === null || expected === '') return true;

  const query = request.query as Record<string, unknown>;
  const supplied = request.headers['x-session-api-key'] ?? query.session_api_key;
  if (supplied !== undefined) {
    if (supplied === expected) return true;
    socket.close(4001, 'Authentication failed');
    return false;
  }

  const message = await readFirstSocketMessage(socket, 10_000).catch(() => null);
  if (message === null) {
    socket.close(4001, 'Authentication failed');
    return false;
  }

  const parsed = parseAuthMessage(message);
  if (parsed?.session_api_key !== expected) {
    socket.close(4001, 'Authentication failed');
    return false;
  }
  return true;
}

function parseAuthMessage(message: unknown): { readonly session_api_key: string } | null {
  try {
    const payload = JSON.parse(bufferToString(message)) as unknown;
    if (typeof payload !== 'object' || payload === null) return null;
    if (!('type' in payload) || payload.type !== 'auth') return null;
    if (!('session_api_key' in payload) || typeof payload.session_api_key !== 'string') return null;
    return { session_api_key: payload.session_api_key };
  } catch {
    return null;
  }
}

export function isAuthControlMessage(data: unknown): boolean {
  // Match redundant auth frames left unread after legacy (query/header) auth.
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
  const record = data as Record<string, unknown>;
  return record.type === 'auth' && Object.keys(record).every((key) => key === 'type' || key === 'session_api_key');
}

function readFirstSocketMessage(socket: SocketLike, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('websocket_first_message_auth_timeout'));
    }, timeoutMs);
    const onMessage = (data: unknown) => {
      cleanup();
      resolve(data);
    };
    const onCloseOrError = () => {
      cleanup();
      reject(new Error('websocket_closed_before_auth'));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('message', onMessage);
      socket.off('close', onCloseOrError);
      socket.off('error', onCloseOrError);
    };
    socket.once('message', onMessage);
    socket.once('close', onCloseOrError);
    socket.once('error', onCloseOrError);
  });
}

export function bufferToString(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data.map((item) => Buffer.from(item as ArrayBuffer))).toString('utf8');
  return String(data);
}

export function isSocketConnected(socket: SocketLike): boolean {
  return socket.readyState === OPEN_SOCKET_STATE;
}

export function safeCloseSocket(socket: SocketLike, code = 1000, reason = 'Connection closed'): void {
  try {
    socket.close(code, reason);
  } catch {
    // WebSocket may already be closed or in an inconsistent state.
  }
}

export function getConversationService(deps: SocketRouteDeps): ConversationService {
  // The conversation service is carried in the route deps rather than a module
  // singleton; session_socket and sockets share the same instance.
  return deps.conversationService;
}

export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: unknown) => void): void;
  on(event: 'close' | 'error', listener: () => void): void;
  once(event: 'message', listener: (data: unknown) => void): void;
  once(event: 'close' | 'error', listener: () => void): void;
  off(event: 'message', listener: (data: unknown) => void): void;
  off(event: 'close' | 'error', listener: () => void): void;
}
