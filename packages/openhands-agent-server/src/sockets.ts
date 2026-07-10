import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { BashEventService } from './bashService.js';
import type { AgentServerConfig } from './config.js';
import type { ConversationService } from './conversationService.js';
import { bashErrorSchema, executeBashRequestSchema, messageFromSendRequest, sendMessageRequestSchema, type BashEvent, type Event } from './models.js';

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
  if (!isSocketAuthorized(request, deps.config)) {
    socket.close(1008, 'Invalid or missing session API key');
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

  const sendEvent = (event: Event): void => {
    if (socket.readyState === OPEN_SOCKET_STATE) socket.send(JSON.stringify(event));
  };
  const subscriberId = await eventService.subscribeToEvents(sendEvent);
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
      await eventService.sendMessage(messageFromSendRequest(requestBody), requestBody.run);
    })().catch((error: unknown) => {
      if (socket.readyState === OPEN_SOCKET_STATE) socket.send(JSON.stringify({ kind: 'ServerErrorEvent', code: 'WebSocketMessageError', detail: error instanceof Error ? error.message : String(error) }));
    });
  });
  socket.on('close', () => void eventService.unsubscribeFromEvents(subscriberId));
  socket.on('error', () => void eventService.unsubscribeFromEvents(subscriberId));
}

async function handleBashEventsSocket(socket: SocketLike, request: FastifyRequest, deps: SocketRouteDeps): Promise<void> {
  if (!isSocketAuthorized(request, deps.config)) {
    socket.close(1008, 'Invalid or missing session API key');
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

function isSocketAuthorized(request: FastifyRequest, config: AgentServerConfig): boolean {
  const expected = config.sessionApiKey;
  if (expected === undefined || expected === null || expected === '') return true;
  const query = request.query as Record<string, unknown>;
  return request.headers['x-session-api-key'] === expected || query.session_api_key === expected;
}

function bufferToString(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data.map((item) => Buffer.from(item as ArrayBuffer))).toString('utf8');
  return String(data);
}

interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: unknown) => void): void;
  on(event: 'close' | 'error', listener: () => void): void;
}
