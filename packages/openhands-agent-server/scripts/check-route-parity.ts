import { routeSpecs } from '../src/openapi.js';
import { loadUpstreamManifest } from './upstream-manifest.js';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type RouteKey = `${Method} ${string}`;

const pinnedBaseCommit = loadUpstreamManifest().commit;

const upstreamSnapshot = routeKeys([
  ['GET', '/'],
  ['GET', '/alive'],
  ['GET', '/health'],
  ['GET', '/ready'],
  ['GET', '/server_info'],

  ['GET', '/api/conversations/search'],
  ['GET', '/api/conversations/count'],
  ['GET', '/api/conversations/{conversation_id}'],
  ['GET', '/api/conversations/{conversation_id}/agent_final_response'],
  ['GET', '/api/conversations'],
  ['POST', '/api/conversations'],
  ['POST', '/api/conversations/{conversation_id}/pause'],
  ['POST', '/api/conversations/{conversation_id}/interrupt'],
  ['DELETE', '/api/conversations/{conversation_id}'],
  ['POST', '/api/conversations/{conversation_id}/run'],
  ['POST', '/api/conversations/{conversation_id}/goal'],
  ['POST', '/api/conversations/{conversation_id}/goal/stop'],
  ['POST', '/api/conversations/{conversation_id}/goal/resume'],
  ['POST', '/api/conversations/{conversation_id}/secrets'],
  ['POST', '/api/conversations/{conversation_id}/confirmation_policy'],
  ['POST', '/api/conversations/{conversation_id}/security_analyzer'],
  ['POST', '/api/conversations/{conversation_id}/switch_profile'],
  ['POST', '/api/conversations/{conversation_id}/switch_llm'],
  ['POST', '/api/conversations/{conversation_id}/switch_acp_model'],
  ['PATCH', '/api/conversations/{conversation_id}'],
  ['POST', '/api/conversations/{conversation_id}/ask_agent'],
  ['POST', '/api/conversations/{conversation_id}/condense'],
  ['POST', '/api/conversations/{conversation_id}/fork'],

  ['GET', '/api/conversations/{conversation_id}/events/search'],
  ['GET', '/api/conversations/{conversation_id}/events/count'],
  ['GET', '/api/conversations/{conversation_id}/events/{event_id}'],
  ['GET', '/api/conversations/{conversation_id}/events'],
  ['POST', '/api/conversations/{conversation_id}/events'],
  ['POST', '/api/conversations/{conversation_id}/events/respond_to_confirmation'],

  ['GET', '/api/bash/bash_events/search'],
  ['GET', '/api/bash/bash_events/{event_id}'],
  ['GET', '/api/bash/bash_events'],
  ['POST', '/api/bash/start_bash_command'],
  ['POST', '/api/bash/execute_bash_command'],
  ['DELETE', '/api/bash/bash_events'],

  ['POST', '/api/file/upload'],
  ['GET', '/api/file/download'],
  ['GET', '/api/file/home'],
  ['GET', '/api/file/search_subdirs'],
  ['GET', '/api/file/download-trajectory/{conversation_id}'],

  ['GET', '/api/git/changes'],
  ['GET', '/api/git/diff'],

  ['GET', '/api/settings/agent-schema'],
  ['GET', '/api/settings/conversation-schema'],
  ['GET', '/api/settings'],
  ['PATCH', '/api/settings'],
  ['GET', '/api/settings/secrets'],
  ['GET', '/api/settings/secrets/{name}'],
  ['PUT', '/api/settings/secrets'],
  ['DELETE', '/api/settings/secrets/{name}'],

  ['POST', '/api/skills'],
  ['POST', '/api/skills/sync'],
  ['POST', '/api/skills/install'],
  ['GET', '/api/skills/installed'],
  ['GET', '/api/skills/installed/{skill_name}'],
  ['PATCH', '/api/skills/installed/{skill_name}'],
  ['DELETE', '/api/skills/installed/{skill_name}'],
  ['POST', '/api/skills/installed/{skill_name}/refresh'],
  ['GET', '/api/skills/marketplace'],

  ['GET', '/api/profiles'],
  ['GET', '/api/profiles/{name}'],
  ['POST', '/api/profiles/{name}'],
  ['DELETE', '/api/profiles/{name}'],
  ['POST', '/api/profiles/{name}/rename'],
  ['POST', '/api/profiles/{name}/activate'],

  ['GET', '/api/agent-profiles'],
  ['GET', '/api/agent-profiles/{name}'],
  ['POST', '/api/agent-profiles/{name}'],
  ['DELETE', '/api/agent-profiles/{name}'],
  ['POST', '/api/agent-profiles/{name}/rename'],
  ['POST', '/api/agent-profiles/{profile_id}/activate'],
  ['POST', '/api/agent-profiles/{name}/materialize'],

  ['POST', '/api/auth/workspace-session'],
  ['DELETE', '/api/auth/workspace-session'],
  ['GET', '/api/desktop/url'],
  ['POST', '/api/hooks'],
  ['GET', '/api/init'],
  ['POST', '/api/init'],
  ['GET', '/api/llm/providers'],
  ['GET', '/api/llm/models'],
  ['GET', '/api/llm/models/verified'],
  ['GET', '/api/llm/subscription/openai/models'],
  ['GET', '/api/llm/subscription/openai/status'],
  ['POST', '/api/llm/subscription/openai/device/start'],
  ['POST', '/api/llm/subscription/openai/device/poll'],
  ['POST', '/api/llm/subscription/openai/logout'],
  ['POST', '/api/mcp/test'],
  ['GET', '/v1/models'],
  ['POST', '/v1/chat/completions'],
  ['GET', '/api/tools'],
  ['GET', '/api/vscode/url'],
  ['GET', '/api/vscode/status'],
  ['GET', '/api/conversations/{conversation_id}/workspace'],
  ['GET', '/api/conversations/{conversation_id}/workspace/{file_path}'],
  ['GET', '/api/workspaces'],
  ['POST', '/api/workspaces'],
  ['DELETE', '/api/workspaces'],
  ['POST', '/api/workspaces/parents'],
  ['DELETE', '/api/workspaces/parents'],
]);

const acceptedDeferrals = new Map<RouteKey, string>([
  ['POST /api/conversations/{conversation_id}/switch_profile', 'profile switching requires upstream runtime/session integration not present in this TS slice'],
  ['POST /api/conversations/{conversation_id}/switch_llm', 'LLM switching requires upstream runtime/session integration not present in this TS slice'],
  ['POST /api/conversations/{conversation_id}/switch_acp_model', 'ACP runtime is an accepted SDK/server transpile deviation'],
  ['GET /api/file/download-trajectory/{conversation_id}', 'trajectory archives are generated by upstream runtime artifacts not ported yet'],
  ['POST /api/auth/workspace-session', 'workspace session auth belongs to browser workspace mode, not this package slice'],
  ['DELETE /api/auth/workspace-session', 'workspace session auth belongs to browser workspace mode, not this package slice'],
  ['GET /api/desktop/url', 'desktop integration endpoint is deployment-specific'],
  ['POST /api/hooks', 'hook persistence/execution is intentionally deferred'],
  ['GET /api/init', 'init flow is a UI/bootstrap integration endpoint deferred from this server slice'],
  ['POST /api/init', 'init flow is a UI/bootstrap integration endpoint deferred from this server slice'],
  ['GET /api/llm/providers', 'provider catalog is superseded by local profile/settings APIs in this package'],
  ['GET /api/llm/models', 'model catalog is superseded by local profile/settings APIs in this package'],
  ['GET /api/llm/models/verified', 'model catalog is superseded by local profile/settings APIs in this package'],
  ['GET /api/llm/subscription/openai/models', 'OpenHands subscription runtime is not part of the TS package'],
  ['GET /api/llm/subscription/openai/status', 'OpenHands subscription runtime is not part of the TS package'],
  ['POST /api/llm/subscription/openai/device/start', 'OpenHands subscription runtime is not part of the TS package'],
  ['POST /api/llm/subscription/openai/device/poll', 'OpenHands subscription runtime is not part of the TS package'],
  ['POST /api/llm/subscription/openai/logout', 'OpenHands subscription runtime is not part of the TS package'],
  ['POST /api/mcp/test', 'MCP runtime wiring is outside the first server package slice'],
  ['GET /v1/models', 'OpenAI-compatible proxy is outside the first server package slice'],
  ['POST /v1/chat/completions', 'OpenAI-compatible proxy is outside the first server package slice'],
  ['GET /api/tools', 'tool catalog endpoint is not needed until tool registry exposure is ported'],
  ['GET /api/vscode/url', 'VS Code integration endpoint is deployment-specific'],
  ['GET /api/vscode/status', 'VS Code integration endpoint is deployment-specific'],
  ['GET /api/conversations/{conversation_id}/workspace', 'workspace browsing endpoints are deferred pending workspace API design'],
  ['GET /api/conversations/{conversation_id}/workspace/{file_path}', 'workspace browsing endpoints are deferred pending workspace API design'],
  ['GET /api/workspaces', 'multi-workspace management is outside this package slice'],
  ['POST /api/workspaces', 'multi-workspace management is outside this package slice'],
  ['DELETE /api/workspaces', 'multi-workspace management is outside this package slice'],
  ['POST /api/workspaces/parents', 'multi-workspace parent management is outside this package slice'],
  ['DELETE /api/workspaces/parents', 'multi-workspace parent management is outside this package slice'],
]);

const implemented = new Set(routeSpecs.map((route) => `${route.method.toUpperCase()} ${route.path}` as RouteKey));
const missing = [...upstreamSnapshot].filter((route) => !implemented.has(route) && !acceptedDeferrals.has(route));
const staleDeferrals = [...acceptedDeferrals.keys()].filter((route) => implemented.has(route));
const unknownDeferrals = [...acceptedDeferrals.keys()].filter((route) => !upstreamSnapshot.has(route));

if (missing.length > 0 || staleDeferrals.length > 0 || unknownDeferrals.length > 0) {
  console.error(`Route parity check failed against OpenHands ${pinnedBaseCommit}.`);
  if (missing.length > 0) {
    console.error('\nMissing upstream routes without accepted deferral:');
    for (const route of missing) console.error(`  - ${route}`);
  }
  if (staleDeferrals.length > 0) {
    console.error('\nRoutes are implemented but still listed as deferred:');
    for (const route of staleDeferrals) console.error(`  - ${route}`);
  }
  if (unknownDeferrals.length > 0) {
    console.error('\nAccepted deferrals absent from the pinned upstream snapshot:');
    for (const route of unknownDeferrals) console.error(`  - ${route}`);
  }
  process.exit(1);
}

const implementedUpstream = [...upstreamSnapshot].filter((route) => implemented.has(route)).length;
const extensions = [...implemented].filter((route) => !upstreamSnapshot.has(route)).length;
console.log(
  `Route parity check passed against OpenHands ${pinnedBaseCommit}: `
  + `${upstreamSnapshot.size} upstream operations (${implementedUpstream} implemented, ${acceptedDeferrals.size} accepted deferrals); `
  + `${extensions} additional TypeScript operations.`,
);

function routeKeys(input: ReadonlyArray<readonly [Method, string]>): ReadonlySet<RouteKey> {
  return new Set(input.map(([method, path]) => `${method} ${path}` as RouteKey));
}
