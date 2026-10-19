import type { ApiKeyRefreshHook, LLMProfile } from '@smolpaws/openhands-agent';

export interface ManagedLlmKeyOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
}

/** Runtime-only adapter; credentials never become part of the profile. */
export function createManagedLlmKeyRefreshHook(profile: LLMProfile, options: ManagedLlmKeyOptions = {}): ApiKeyRefreshHook | undefined {
  const env = options.env ?? process.env;
  const url = env.OH_LLM_API_KEY_REFRESH_URL?.trim();
  const allowed = new Set((env.OH_LLM_API_KEY_REFRESH_BASE_URLS ?? '').split(',').map(value => value.trim().replace(/\/+$/u, '')).filter(Boolean));
  // Native clients use explicit profile endpoints; model text alone never grants
  // permission to replace a BYOK credential with the control plane's key.
  if (!url || profile.authType !== 'api_key' || profile.baseUrl === null || !allowed.has(profile.baseUrl.replace(/\/+$/u, ''))) return undefined;
  const headers = loadHeaders(env.OH_LLM_API_KEY_REFRESH_HEADERS, env);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  return async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      // httpx.get does not follow redirects; preserve that boundary for auth headers.
      const response = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal, redirect: 'error' });
      if (!response.ok) return null;
      return (await response.text()).trim() || null;
    } catch {
      // The SDK retains the original authentication error. Never expose response
      // bodies, environment headers or network exception text in diagnostics.
      return null;
    } finally { clearTimeout(timer); }
  };
}

function loadHeaders(raw: string | undefined, env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).map(([name, value]: [string, unknown]) => [name,
      headerString(value).replace(/\$(\w+|\{[^}]*\})/gu, (match: string, variable: string) => {
        const key = variable.startsWith('{') ? variable.slice(1, -1) : variable;
        return Object.hasOwn(env, key) ? env[key] ?? match : match;
      }),
    ]));
  } catch { return {}; }
}

// Match Python's str coercion for JSON header values, including nested repr.
function headerString(value: unknown, nested = false): string {
  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'string') {
    if (!nested) return value;
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    return quote + value.replace(/\\/gu, '\\\\').replace(new RegExp(quote, 'gu'), '\\' + quote)
      .replace(/\n/gu, '\\n').replace(/\r/gu, '\\r').replace(/\t/gu, '\\t') + quote;
  }
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return '[' + value.map(item => headerString(item, true)).join(', ') + ']';
  if (typeof value === 'object' && value !== null) return '{' + Object.entries(value).map(([key, item]) => headerString(key, true) + ': ' + headerString(item, true)).join(', ') + '}';
  return '';
}
