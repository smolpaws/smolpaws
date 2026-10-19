import { afterEach, describe, expect, it, vi } from 'vitest';
import { llmProfileSchema } from '@smolpaws/openhands-agent';
import { createManagedLlmKeyRefreshHook } from '../managedLlmKey.js';

const endpoint = 'https://proxy.example.test/v1';
const refresh = 'https://control.example.test/current-key';
const profile = llmProfileSchema.parse({ profileId: 'managed', providerId: 'openai', model: 'gpt-4o', baseUrl: endpoint });
const env = { OH_LLM_API_KEY_REFRESH_URL: refresh, OH_LLM_API_KEY_REFRESH_BASE_URLS: endpoint };
afterEach(() => vi.useRealTimers());

// PORT: Python test_managed_llm_key.py; no ambient credentials or network.
describe('managed key scope', () => {
  it.each([{}, { ...env, OH_LLM_API_KEY_REFRESH_URL: '' }, { ...env, OH_LLM_API_KEY_REFRESH_URL: '  ' }, { OH_LLM_API_KEY_REFRESH_URL: refresh }, { ...env, OH_LLM_API_KEY_REFRESH_BASE_URLS: ' , ' }])('stays off without both explicit configuration values (%j)', settings => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(createManagedLlmKeyRefreshHook(profile, { env: settings, fetch })).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    { ...profile, baseUrl: 'https://api.openai.com/v1' },
    { ...profile, baseUrl: 'https://proxy.example.test/v10' },
    { ...profile, baseUrl: 'https://proxy.example.test.evil/v1' },
    { ...profile, baseUrl: 'https://proxy.example.test/v1?other=1' },
    { ...profile, baseUrl: null, model: 'openhands/gpt-4o' },
    { ...profile, authType: 'subscription' as const },
  ])('excludes BYOK, near matches, inferred model routes and subscriptions (%j)', candidate => {
    expect(createManagedLlmKeyRefreshHook(candidate, { env })).toBeUndefined();
  });
  it.each([[endpoint, endpoint + '/'], [endpoint + '///', endpoint], [endpoint, ' https://other.example.test, ' + endpoint + '/, ']])('matches exact endpoints after slash normalization', async (baseUrl, allowlist) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(' fresh-key\n'));
    const selected = Object.freeze({ ...profile, baseUrl });
    const hook = createManagedLlmKeyRefreshHook(selected, { env: { ...env, OH_LLM_API_KEY_REFRESH_BASE_URLS: allowlist }, fetch });
    expect(hook).toBeTypeOf('function');
    expect(await hook!()).toBe('fresh-key');
    expect(fetch).toHaveBeenCalledExactlyOnceWith(refresh, expect.objectContaining({ method: 'GET', redirect: 'error' }));
    expect(JSON.stringify(selected)).not.toContain('fresh-key');
  });
});

describe('fresh bounded refresh GET', () => {
  it('expands both environment syntaxes, keeps unknown references and reads fresh keys', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(' first-key ')).mockResolvedValueOnce(new Response('second-key'));
    const hook = createManagedLlmKeyRefreshHook(profile, { fetch, env: { ...env, SESSION: 'synthetic-session', OH_LLM_API_KEY_REFRESH_HEADERS: JSON.stringify({ 'X-Session': '${SESSION}', 'X-Bare': '$SESSION', 'X-Unknown': '${UNKNOWN}/$UNKNOWN', 'X-Static': 'plain' }) } });
    expect(await hook!()).toBe('first-key');
    expect(await hook!()).toBe('second-key');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]![1]?.headers).toEqual({ 'X-Session': 'synthetic-session', 'X-Bare': 'synthetic-session', 'X-Unknown': '${UNKNOWN}/$UNKNOWN', 'X-Static': 'plain' });
  });
  it.each(['not-json', '["a","b"]', 'null', 'true', '42'])('ignores malformed/non-object header configuration %s', async raw => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('fresh'));
    const hook = createManagedLlmKeyRefreshHook(profile, { fetch, env: { ...env, OH_LLM_API_KEY_REFRESH_HEADERS: raw } });
    expect(await hook!()).toBe('fresh');
    expect(fetch.mock.calls[0]![1]?.headers).toEqual({});
  });
  it.each(['http', 'empty', 'network', 'body'])('returns null without exposing refresh failure %s', async failure => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      if (failure === 'network') throw new Error('private-network-secret');
      const response = new Response(failure === 'empty' ? ' \n' : 'private-response-secret', { status: failure === 'http' ? 503 : 200 });
      if (failure === 'body') vi.spyOn(response, 'text').mockRejectedValue(new Error('private-body-secret'));
      return response;
    });
    const hook = createManagedLlmKeyRefreshHook(profile, { fetch, env });
    expect(await hook!()).toBeNull();
  });
  it('aborts after 30 seconds and releases the deadline timer', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_url, init) => {
      signal = init?.signal;
      return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('private-abort')), { once: true }));
    });
    const hook = createManagedLlmKeyRefreshHook(profile, { fetch, env });
    const pending = hook!();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBeNull();
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
