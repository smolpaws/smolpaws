import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import { AgentControlledCondensationError, BROWSER_TOOL_NAME, isToolAvailable, MacOSKeychainSecretStore, OpenAISubscriptionAuth, createClientFromProfile, type MetaProfileStore, type SecretStore } from '@smolpaws/openhands-agent';

import { launchHttpError, previewClient } from './launch.js';
import { createProfileToolMaterializer } from './profileTools.js';
import { registerAgentProfileRoutes } from './agentProfilesRouter.js';
import { BashEventService } from './bashService.js';
import { ConversationRunLimitExceeded } from './runAdmission.js';
import { ConversationLeaseHeldError, ConversationLeaseInvalidError, ConversationOwnershipLostError } from './conversationLease.js';
import { type AgentServerConfig, getDefaultConfig } from './config.js';
import { registerConversationRoutes } from './conversationRouter.js';
import { ConversationService, type ConversationServiceOptions } from './conversationService.js';
import { defaultErrorLogger } from './errorDiagnostics.js';
import { registerEventRoutes } from './eventRouter.js';
import { registerFileRoutes } from './fileRouter.js';
import { registerGitRoutes } from './gitRouter.js';
import { registerLlmRoutes } from './llmRouter.js';
import { registerMetaProfileRoutes } from './metaProfilesRouter.js';
import { createManagedLlmKeyRefreshHook } from './managedLlmKey.js';
import { generateOpenApiSchema } from './openapi.js';
import { createProfileAgentFactory, prepareProfileStartRequest, type ProfileContextConfigurator, type ProfileLlmClientFactory, type ProfileToolConfigurator } from './profileAgentFactory.js';
import { registerProfileRoutes } from './profilesRouter.js';
import { registerBashRoutes } from './bashRouter.js';
import { McpServerNotFoundError, ServerStateService } from './serverState.js';
import { registerSettingsRoutes } from './settingsRouter.js';
import { registerToolRoutes } from './toolRouter.js';
import { registerSkillsRoutes } from './skillsRouter.js';
import { SkillsCatalogService } from './skillsService.js';
import { registerSubAgentRoutes, usableServerTools } from './subAgentsRouter.js';
import { registerSessionSocket } from './sessionSocket.js';
import { registerSocketRoutes } from './sockets.js';
import type { ProfileSelectionResolver } from './profileRuntime.js';

const startedAt = Date.now();

export interface AgentServerAppOptions extends ConversationServiceOptions {
  readonly config?: Partial<AgentServerConfig>;
  readonly gitProviderFetch?: typeof fetch;
  readonly skillsCatalogService?: SkillsCatalogService;
  readonly conversationService?: ConversationService;
  readonly secretStore?: SecretStore;
  readonly serverStateService?: ServerStateService;
  readonly metaProfileStore?: MetaProfileStore;
  readonly llmClientFactory?: ProfileLlmClientFactory;
  readonly configureTools?: ProfileToolConfigurator;
  readonly configureContext?: ProfileContextConfigurator;
  readonly logger?: boolean;
  readonly subscriptionAuth?: OpenAISubscriptionAuth;
  readonly resolveProfileSelection?: ProfileSelectionResolver;
  readonly resolveCondenserProfileSelection?: ProfileSelectionResolver;
}

export interface AgentServerApp {
  readonly app: FastifyInstance;
  readonly conversationService: ConversationService;
  readonly serverStateService: ServerStateService;
}

export async function createAgentServerApp(options: AgentServerAppOptions = {}): Promise<AgentServerApp> {
  if (options.conversationService !== undefined && (
    options.errorLogger !== undefined
    || options.agentFactory !== undefined
    || options.getDefaultAgentSettings !== undefined
    || options.persistenceDir !== undefined
    || options.ownerInstanceId !== undefined
    || options.leaseTtlMs !== undefined
    || options.config?.conversationsPath !== undefined
    || options.resolveProfileSelection !== undefined
    || options.resolveCondenserProfileSelection !== undefined
    || options.profileRuntime !== undefined
    || options.maxConcurrentRuns !== undefined
    || options.config?.maxConcurrentRuns !== undefined
    || options.initializeOnCreate !== undefined
    || options.observability !== undefined
  )) {
    throw new Error('conversationService cannot be combined with managed conversation-service options');
  }
  const defaultConfig = getDefaultConfig();
  if (options.persistenceDir !== undefined && options.config?.conversationsPath !== undefined && options.persistenceDir !== options.config.conversationsPath) {
    throw new Error('persistenceDir and config.conversationsPath must match when both are provided');
  }
  const conversationsPath = options.persistenceDir ?? options.config?.conversationsPath ?? defaultConfig.conversationsPath;
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
  if (options.serverStateService !== undefined && options.metaProfileStore !== undefined
    && options.serverStateService.metaProfileStore !== options.metaProfileStore) throw new Error('serverStateService and metaProfileStore must share the same store');
  const serverStateService = options.serverStateService ?? new ServerStateService({ stateDir: config.statePath, secretStore,
    ...(options.metaProfileStore === undefined ? {} : { metaProfileStore: options.metaProfileStore }) });
  const skillsCatalogService = options.skillsCatalogService ?? new SkillsCatalogService({ stateDir: config.statePath, workspaceRoot: config.workspaceRoot });
  const profileCatalog = () => skillsCatalogService.discoverProfileCatalog();
  const browserAvailable = config.enableBrowser !== false && isToolAvailable(BROWSER_TOOL_NAME);
  const subscriptionAuth = options.subscriptionAuth ?? new OpenAISubscriptionAuth();
  const llmClientFactory: ProfileLlmClientFactory = (profile, store) => {
    const apiKeyRefreshHook = createManagedLlmKeyRefreshHook(profile);
    const runtimeOptions = { subscriptionAuth, ...(apiKeyRefreshHook === undefined ? {} : { apiKeyRefreshHook }) };
    return (options.llmClientFactory ?? createClientFromProfile)(profile, store, runtimeOptions);
  };
  const usesProfileAgentFactory = options.agentFactory === undefined && options.conversationService === undefined;
  if (options.agentFactory !== undefined && options.resolveProfileSelection !== undefined) {
    throw new Error('resolveProfileSelection requires the profile agent factory');
  }
  if (options.agentFactory !== undefined && options.resolveCondenserProfileSelection !== undefined) {
    throw new Error('resolveCondenserProfileSelection requires the profile agent factory');
  }
  const agentFactory = options.agentFactory ?? createProfileAgentFactory({
    state: serverStateService,
    conversationsPath: config.conversationsPath,
    browserAvailable,
    metaProfileStore: serverStateService.metaProfileStore,
    secretStore,
    ...(options.configureTools === undefined ? {} : { configureTools: options.configureTools }),
    ...(options.configureContext === undefined ? {} : { configureContext: options.configureContext }),
    llmClientFactory,
    ...(options.resolveCondenserProfileSelection === undefined ? {} : { resolveCondenserProfileSelection: options.resolveCondenserProfileSelection }),
  });
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 25 * 1024 * 1024 });
  const serviceOptions: ConversationServiceOptions = {
    errorLogger: options.errorLogger ?? (options.logger === true ? app.log : defaultErrorLogger),
    persistenceDir: config.conversationsPath,
    maxConcurrentRuns: options.maxConcurrentRuns ?? config.maxConcurrentRuns,
    initializeOnCreate: options.initializeOnCreate ?? usesProfileAgentFactory,
    ...(options.observability === undefined ? {} : { observability: options.observability }),
    secretStore,
    agentFactory,
    ...(usesProfileAgentFactory
      ? { getDefaultAgentSettings: () => serverStateService.agentSettings() }
      : options.getDefaultAgentSettings === undefined ? {} : { getDefaultAgentSettings: options.getDefaultAgentSettings }),
    ...(usesProfileAgentFactory ? { profileRuntime: {
      getProfile: (name: string) => serverStateService.getProfile(name),
      createClient: (profile: Parameters<ProfileLlmClientFactory>[0]) => llmClientFactory(profile, secretStore),
      ...(options.resolveProfileSelection === undefined ? {} : { resolveProfileSelection: options.resolveProfileSelection }),
    } } : options.profileRuntime === undefined ? {} : { profileRuntime: options.profileRuntime }),
    ...(options.ownerInstanceId === undefined ? {} : { ownerInstanceId: options.ownerInstanceId }),
    ...(options.leaseTtlMs === undefined ? {} : { leaseTtlMs: options.leaseTtlMs }),
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
  registerConversationRoutes(app, conversationService, usesProfileAgentFactory ? {
    prepareStartRequest: (input) => prepareProfileStartRequest(input, serverStateService, {
      deferCondenserResolution: options.resolveCondenserProfileSelection !== undefined,
      profileCatalog,
    }),
  } : {});
  registerEventRoutes(app, conversationService);
  registerBashRoutes(app, bashEventService);
  registerGitRoutes(app, {
    resolveSecret: name => serverStateService.resolveSecret(name),
    ...(options.gitProviderFetch === undefined ? {} : { fetch: options.gitProviderFetch }),
  });
  registerFileRoutes(app, config);
  registerLlmRoutes(app, subscriptionAuth);
  registerSettingsRoutes(app, serverStateService);
  registerProfileRoutes(app, serverStateService, llmClientFactory, secretStore);
  registerMetaProfileRoutes(app, serverStateService);
  registerToolRoutes(app);
  registerSubAgentRoutes(app, config);
  registerAgentProfileRoutes(app, serverStateService, { launchOptions: { profileCatalog }, runtime: {
    browserAvailable,
    createClient: previewClient,
    materializeTools: createProfileToolMaterializer({
      state: serverStateService, secretStore, metaProfileStore: serverStateService.metaProfileStore,
      llmClientFactory: async profile => previewClient(profile), workingDir: config.workspaceRoot, persistenceDir: null,
    }),
  } });
  registerSkillsRoutes(app, { service: skillsCatalogService });
  registerSocketRoutes(app, { config, conversationService, bashEventService });
  registerSessionSocket(app, { config, conversationService });
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
    const launchFailure = launchHttpError(error);
    if (launchFailure !== null) {
      reply.status(launchFailure.statusCode).send({ detail: launchFailure.detail });
      return;
    }
    if (error instanceof z.ZodError) {
      reply.status(422).send({ detail: error.issues.map((issue) => ({ path: issue.path, message: issue.message })) });
      return;
    }
    if (error instanceof ConversationRunLimitExceeded) {
      reply.status(429).send({ detail: error.message });
      return;
    }
    if (error instanceof AgentControlledCondensationError) {
      reply.status(409).send({ code: 'agent_controlled_condensation', detail: error.message });
      return;
    }
    if (error instanceof ConversationLeaseHeldError || error instanceof ConversationLeaseInvalidError || error instanceof ConversationOwnershipLostError) {
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
    usable_tools: usableServerTools(config),
    runtime_idle_timeout_seconds: null,
    max_foreground_terminal_timeout_seconds: null,
    docs: '/docs',
    redoc: '/redoc',
    initialized: true,
    conversation_runtime: 'local',
    app_backend_ingress_url: null,
    capabilities: ['idempotent_conversation_create_v1', 'profile_persona_v1', 'tool_catalog_v1', 'agent_profile_draft_materialize_v1'],
    web_url: config.webUrl ?? null,
  };
}
