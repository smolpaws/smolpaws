import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import { MacOSKeychainSecretStore, createClientFromProfile, type SecretStore } from '@smolpaws/openhands-agent';

import { registerAgentProfileRoutes } from './agentProfilesRouter.js';
import { BashEventService } from './bashService.js';
import { ConversationLeaseHeldError, ConversationOwnershipLostError } from './conversationLease.js';
import { type AgentServerConfig, getDefaultConfig } from './config.js';
import { registerConversationRoutes } from './conversationRouter.js';
import { ConversationService, type ConversationServiceOptions } from './conversationService.js';
import { registerEventRoutes } from './eventRouter.js';
import { registerFileRoutes } from './fileRouter.js';
import { registerGitRoutes } from './gitRouter.js';
import { generateOpenApiSchema } from './openapi.js';
import { createProfileAgentFactory, prepareProfileStartRequest, type ProfileLlmClientFactory } from './profileAgentFactory.js';
import { registerProfileRoutes } from './profilesRouter.js';
import { registerBashRoutes } from './bashRouter.js';
import { McpServerNotFoundError, ServerStateService } from './serverState.js';
import { registerSettingsRoutes } from './settingsRouter.js';
import { registerSkillsRoutes } from './skillsRouter.js';
import { registerSocketRoutes } from './sockets.js';

const startedAt = Date.now();

export interface AgentServerAppOptions extends ConversationServiceOptions {
  readonly config?: Partial<AgentServerConfig>;
  readonly conversationService?: ConversationService;
  readonly secretStore?: SecretStore;
  readonly serverStateService?: ServerStateService;
  readonly llmClientFactory?: ProfileLlmClientFactory;
  readonly logger?: boolean;
}

export interface AgentServerApp {
  readonly app: FastifyInstance;
  readonly conversationService: ConversationService;
  readonly serverStateService: ServerStateService;
}

export async function createAgentServerApp(options: AgentServerAppOptions = {}): Promise<AgentServerApp> {
  const defaultConfig = getDefaultConfig();
  const conversationsPath = options.config?.conversationsPath ?? defaultConfig.conversationsPath;
  const workspaceRoot = options.config?.workspaceRoot ?? defaultConfig.workspaceRoot;
  const allowedFileRoots = options.config?.allowedFileRoots ?? (options.config?.workspaceRoot === undefined ? defaultConfig.allowedFileRoots : [workspaceRoot]);
  const config: AgentServerConfig = {
    ...defaultConfig,
    ...options.config,
    conversationsPath,
    bashEventsPath: options.config?.bashEventsPath ?? defaultConfig.bashEventsPath,
    statePath: options.config?.statePath ?? defaultConfig.statePath,
    workspaceRoot,
    allowedFileRoots,
  };
  const secretStore = options.secretStore ?? new MacOSKeychainSecretStore();
  const serverStateService = options.serverStateService ?? new ServerStateService({ stateDir: config.statePath, secretStore });
  const usesProfileAgentFactory = options.agentFactory === undefined && options.conversationService === undefined;
  const agentFactory = options.agentFactory ?? createProfileAgentFactory({
    state: serverStateService,
    secretStore,
    ...(options.llmClientFactory === undefined ? {} : { llmClientFactory: options.llmClientFactory }),
  });
  const serviceOptions: ConversationServiceOptions = {
    persistenceDir: config.conversationsPath,
    secretStore,
    agentFactory,
  };
  const conversationService = options.conversationService ?? new ConversationService(serviceOptions);
  const bashEventService = new BashEventService({ bashEventsDir: config.bashEventsPath });
  const retentionSeconds = config.bashEventsRetentionSeconds;
  if (retentionSeconds !== null && (!Number.isInteger(retentionSeconds) || retentionSeconds <= 0)) {
    throw new Error('bashEventsRetentionSeconds must be a positive integer');
  }
  const retentionController = retentionSeconds === null ? null : new AbortController();
  const retentionTask = retentionSeconds === null || retentionController === null
    ? null
    : bashEventService.runRetentionCleanupLoop(retentionSeconds, undefined, retentionController.signal);
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 25 * 1024 * 1024 });

  await app.register(multipart);
  await app.register(websocket);
  // FastAPI (the pinned upstream) serves JSON request bodies on the GET batch
  // endpoints (conversations/events/bash events). Fastify defaults GET to a
  // "bodyless" method and drops such bodies, so reclassify GET as body-capable to
  // preserve the upstream REST contract. The corresponding route handlers already
  // read `request.body`.
  app.addHttpMethod('GET', { hasBody: true });
  registerAuth(app, config);
  registerServerDetailsRoutes(app, config);
  registerConversationRoutes(app, conversationService, usesProfileAgentFactory ? { prepareStartRequest: (input) => prepareProfileStartRequest(input, serverStateService) } : {});
  registerEventRoutes(app, conversationService);
  registerBashRoutes(app, bashEventService);
  registerGitRoutes(app);
  registerFileRoutes(app, config);
  registerSettingsRoutes(app, serverStateService);
  registerProfileRoutes(app, serverStateService, options.llmClientFactory ?? createClientFromProfile, secretStore);
  registerAgentProfileRoutes(app, serverStateService);
  registerSkillsRoutes(app, { stateDir: config.statePath, workspaceRoot: config.workspaceRoot });
  registerSocketRoutes(app, { config, conversationService, bashEventService });
  app.addHook('onClose', async () => {
    retentionController?.abort();
    await Promise.all([conversationService.close(), bashEventService.close(), retentionTask]);
  });
  registerErrorHandler(app);

  return { app, conversationService, serverStateService };
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

function registerServerDetailsRoutes(app: FastifyInstance, config: AgentServerConfig): void {
  const health = async () => ({ status: 'ok' });
  app.get('/', async () => serverInfo(config));
  app.get('/alive', health);
  app.get('/health', health);
  app.get('/ready', async () => ({ status: 'ready' }));
  app.get('/server_info', async () => serverInfo(config));
  app.get('/openapi.json', async () => generateOpenApiSchema());
}

function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      reply.status(422).send({ detail: error.issues.map((issue) => ({ path: issue.path, message: issue.message })) });
      return;
    }
    if (error instanceof ConversationLeaseHeldError || error instanceof ConversationOwnershipLostError) {
      reply.status(409).send({ detail: error.message });
      return;
    }
    if (error instanceof McpServerNotFoundError) {
      reply.status(404).send({ detail: error.message });
      return;
    }
    if (error instanceof Error && error.message.startsWith('invalid_conversation_secret_name:')) {
      reply.status(400).send({ detail: error.message });
      return;
    }
    if (error instanceof Error && (error.message === 'profile_not_found' || error.message.startsWith('llm_profile_not_found:'))) {
      reply.status(404).send({ detail: error.message });
      return;
    }
    reply.status(500).send({ detail: error instanceof Error ? error.message : String(error) });
  });
}

function serverInfo(config: AgentServerConfig) {
  const uptime = Math.floor((Date.now() - startedAt) / 1000);
  return {
    status: 'ok' as const,
    uptime,
    idle_time: 0,
    title: 'OpenHands Agent Server',
    version: '0.1.0',
    sdk_version: 'unknown',
    tools_version: 'unknown',
    workspace_version: 'unknown',
    build_git_sha: process.env.OPENHANDS_BUILD_GIT_SHA ?? 'unknown',
    build_git_ref: process.env.OPENHANDS_BUILD_GIT_REF ?? 'unknown',
    python_version: 'not-applicable',
    node_version: process.version,
    usable_tools: ['bash', 'file', 'git'],
    runtime_idle_timeout_seconds: null,
    max_foreground_terminal_timeout_seconds: null,
    docs: '/docs',
    redoc: '/redoc',
    initialized: true,
    web_url: config.webUrl ?? null,
  };
}
