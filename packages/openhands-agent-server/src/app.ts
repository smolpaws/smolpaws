import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import { ConversationService, type ConversationServiceOptions } from './conversationService.js';
import { type AgentServerConfig, getDefaultConfig } from './config.js';
import { registerConversationRoutes } from './conversationRouter.js';
import { registerEventRoutes } from './eventRouter.js';
import { generateOpenApiSchema } from './openapi.js';
import { registerSocketRoutes } from './sockets.js';

const startedAt = Date.now();

export interface AgentServerAppOptions extends ConversationServiceOptions {
  readonly config?: AgentServerConfig;
  readonly conversationService?: ConversationService;
  readonly logger?: boolean;
}

export interface AgentServerApp {
  readonly app: FastifyInstance;
  readonly conversationService: ConversationService;
}

export async function createAgentServerApp(options: AgentServerAppOptions = {}): Promise<AgentServerApp> {
  const config = options.config ?? getDefaultConfig();
  const serviceOptions: ConversationServiceOptions = options.agentFactory === undefined ? {} : { agentFactory: options.agentFactory };
  const conversationService = options.conversationService ?? new ConversationService(serviceOptions);
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 25 * 1024 * 1024 });

  await app.register(websocket);
  registerAuth(app, config);
  registerServerDetailsRoutes(app);
  registerConversationRoutes(app, conversationService);
  registerEventRoutes(app, conversationService);
  registerSocketRoutes(app, { config, conversationService });
  registerErrorHandler(app);

  return { app, conversationService };
}

function registerAuth(app: FastifyInstance, config: AgentServerConfig): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    const expected = config.sessionApiKey;
    if (expected === undefined || expected === null || expected === '') return;
    if (request.headers['x-session-api-key'] !== expected) {
      reply.status(401).send({ detail: 'Invalid or missing session API key' });
    }
  });
}

function registerServerDetailsRoutes(app: FastifyInstance): void {
  const health = async () => ({ status: 'ok' as const });
  app.get('/', async () => serverInfo());
  app.get('/alive', health);
  app.get('/health', health);
  app.get('/ready', health);
  app.get('/server_info', async () => serverInfo());
  app.get('/openapi.json', async () => generateOpenApiSchema());
}

function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      reply.status(422).send({ detail: error.issues.map((issue) => ({ path: issue.path, message: issue.message })) });
      return;
    }
    reply.status(500).send({ detail: error instanceof Error ? error.message : String(error) });
  });
}

function serverInfo() {
  return { status: 'ok' as const, version: '0.1.0', uptime: (Date.now() - startedAt) / 1000, initialized: true };
}
