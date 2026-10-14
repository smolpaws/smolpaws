import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Agent, FinishTool, InMemorySecretStore, TestLLM, conversationErrorEventSchema, messageSchema, type Event } from '@smolpaws/openhands-agent';
import { afterEach, describe, expect, test, vi } from 'vitest';
import Fastify from 'fastify';

import { pathContainsPlaintext } from '../../examples/plaintextScan.js';
import { ConversationLease, defaultLeaseTtlMs } from '../conversationLease.js';
import { createAgentServerApp, type AgentServerApp, type AgentServerAppOptions } from '../app.js';

// Adapted from pinned tests/agent_server/test_event_service.py:
// test_run_exception_emits_conversation_error_event / test_run_conversation_run_error_does_not_double_emit.
const roots: string[] = [];
const servers: AgentServerApp[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const server of servers.splice(0)) await server.app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function finish(id: string) {
  return messageSchema.parse({ role: 'assistant', content: [], tool_calls: [
    { id, name: 'finish', arguments: JSON.stringify({ message: 'resumed' }), origin: 'completion' },
  ] });
}

async function fixture(agentFactory: AgentServerAppOptions['agentFactory'], errorLogger: NonNullable<AgentServerAppOptions['errorLogger']> = { error: vi.fn() }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openhands-conversation-error-'));
  roots.push(root);
  const options = { agentFactory, errorLogger, secretStore: new InMemorySecretStore(), config: {
    conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'),
    bashEventsPath: path.join(root, 'bash'), workspaceRoot: root,
  } };
  const server = await createAgentServerApp(options);
  servers.push(server);
  const created = await server.app.inject({ method: 'POST', url: '/api/conversations', payload: {} });
  expect(created.statusCode).toBe(201);
  return { server, id: created.json<{ id: string }>().id, options, root };
}

async function run(server: AgentServerApp, id: string, status: 'error' | 'finished'): Promise<void> {
  const response = await server.app.inject({ method: 'POST', url: `/api/conversations/${id}/events`,
    payload: { role: 'user', content: 'Continue the saved work.', run: true } });
  expect(response.statusCode).toBe(200);
  await expect.poll(async () => (await server.app.inject(`/api/conversations/${id}`)).json().execution_status).toBe(status);
}

async function closeServer(server: AgentServerApp): Promise<void> {
  await server.app.close();
  const index = servers.indexOf(server);
  if (index !== -1) servers.splice(index, 1);
}

async function errors(server: AgentServerApp, id: string) {
  const response = await server.app.inject(`/api/conversations/${id}/events/search?kind=ConversationErrorEvent`);
  expect(response.statusCode).toBe(200);
  return response.json<{ items: Event[] }>().items;
}

describe('durable conversation run failures', () => {
  test('publishes a provider failure over HTTP and WebSocket, preserves it on restart, and permits a fresh retry', async () => {
    const secret = 'fixture-provider-secret-must-not-persist';
    const requestSecret = 'fixture-request-secret-must-not-serialize';
    const bearerSecret = 'fixture-bearer-secret-must-not-persist';
    const failure = Object.assign(new Error(`bad gateway api_key=${secret}; Authorization: Bearer ${bearerSecret}`), {
      request: { headers: { authorization: `Bearer ${requestSecret}` } },
      cause: new Error(requestSecret),
    });
    const llm = TestLLM.fromMessages([failure, finish('finish-after-retry'), failure]);
    const { server, id, options, root } = await fixture(() => new Agent({ llm, tools: [FinishTool.create()] }));
    const log = vi.spyOn(options.errorLogger, 'error');
    await server.app.listen({ host: '127.0.0.1', port: 0 });
    const address = server.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected TCP server');
    const emitted: Event[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/sockets/events/${id}`);
    sockets.push(socket);
    socket.addEventListener('message', (message) => { emitted.push(JSON.parse(String(message.data)) as Event); });
    await expect.poll(() => emitted.some((event) => event.kind === 'ConversationStateUpdateEvent')).toBe(true);

    await run(server, id, 'error');
    await expect.poll(async () => (await errors(server, id)).length).toBe(1);
    const first = (await errors(server, id))[0]!;
    expect(first).toMatchObject({ kind: 'ConversationErrorEvent', source: 'environment', code: 'Error',
      detail: 'bad gateway api_key=<redacted> Authorization: Bearer <redacted>', classification: { kind: 'transient', retryable: true } });
    await expect.poll(() => emitted.filter((event) => event.kind === 'ConversationErrorEvent')).toEqual([first]);
    await expect.poll(() => emitted.at(-1)).toMatchObject({ kind: 'ConversationStateUpdateEvent', value: { execution_status: 'error' } });
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(log.mock.calls)).not.toContain(requestSecret);
    expect(JSON.stringify(log.mock.calls)).not.toContain(bearerSecret);
    socket.close();
    await closeServer(server);
    expect(await pathContainsPlaintext(root, secret)).toBe(false);
    expect(await pathContainsPlaintext(root, requestSecret)).toBe(false);
    expect(await pathContainsPlaintext(root, bearerSecret)).toBe(false);
    const restored = await createAgentServerApp(options);
    servers.push(restored);
    expect(await errors(restored, id)).toEqual([first]);
    await run(restored, id, 'finished');
    expect(await errors(restored, id)).toEqual([first]);
    await run(restored, id, 'error');
    await expect.poll(async () => (await errors(restored, id)).length).toBe(2);
    const repeated = await errors(restored, id);
    expect(repeated[1]).toMatchObject({ code: 'Error', detail: 'bad gateway api_key=<redacted> Authorization: Bearer <redacted>' });
    expect(repeated[1]!.id).not.toBe(first.id);
    expect(llm.callCount).toBe(3);
  });

  test.each([
    ['fetch failed', 'ECONNREFUSED'],
    ['terminated', 'UND_ERR_SOCKET'],
    ['fetch failed', 'UND_ERR_CONNECT_TIMEOUT'],
  ])('logs %s with its native %s cause through the error logger', async (message, systemCode) => {
    const secret = 'fixture-cause-secret-must-not-serialize';
    const cause = Object.assign(new Error(`${secret}\n    at ${secret}`), {
      code: systemCode, errno: -61, syscall: 'connect', address: '127.0.0.1', port: 443,
      request: { headers: { authorization: secret } }, response: { body: secret },
    });
    const failure = new TypeError(message, { cause });
    const { server, id, root, options } = await fixture(() => new Agent({
      llm: TestLLM.fromMessages([failure, finish('retry-network-error')]), tools: [FinishTool.create()],
    }));
    const log = vi.spyOn(options.errorLogger, 'error');

    await run(server, id, 'error');
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      conversation_id: id, elapsed_ms: expect.any(Number),
      error: expect.objectContaining({
        code: 'TypeError', detail: message, stack_frames: expect.any(Array),
        causes: [expect.objectContaining({
          code: 'Error', system_code: systemCode, errno: -61, syscall: 'connect',
          address: '127.0.0.1', port: 443, stack_frames: expect.any(Array),
        })],
      }),
    }), 'conversation_run_error');
    const encoded = JSON.stringify(log.mock.calls);
    expect(encoded).not.toContain(secret);
    expect(encoded).not.toContain('authorization');
    const persisted = (await errors(server, id))[0]!;
    expect(persisted).toMatchObject({ code: 'TypeError', detail: message });
    expect(persisted).not.toHaveProperty('causes');
    await run(server, id, 'finished');
    expect(await errors(server, id)).toEqual([persisted]);
    await closeServer(server);
    expect(await pathContainsPlaintext(root, secret)).toBe(false);
  });

  test('logs bounded aggregate causes and stack frames without serializing their messages or objects', async () => {
    const secret = 'fixture-aggregate-secret-must-not-serialize';
    const child = Object.assign(new Error(secret), { code: 'ENOTFOUND', syscall: 'getaddrinfo', token: secret });
    child.stack = `${secret}\n    at lookup (https://user:${secret}@private.invalid/check?token=${secret}:1:2)\n    at connect (node:net:1:2)`;
    const aggregate = new AggregateError([child, { token: secret }], secret);
    const failure = new TypeError('fetch failed', { cause: aggregate });
    Object.defineProperty(child, 'cause', { value: failure });
    const { server, id, options } = await fixture(() => { throw failure; });
    const log = vi.spyOn(options.errorLogger, 'error');
    await run(server, id, 'error');
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      conversation_id: id,
      error: expect.objectContaining({ causes: [expect.objectContaining({
        code: 'AggregateError', causes: [expect.objectContaining({ code: 'Error', system_code: 'ENOTFOUND', syscall: 'getaddrinfo' })],
      })] }),
    }), 'conversation_run_error');
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(log.mock.calls)).not.toContain('private.invalid');
  });

  test.each(['DOMException', 'message accessor', 'name accessor', 'stack accessor'])('omits accessor-backed %s cause text without invoking getters', async (kind) => {
    const secret = 'fixture-accessor-cause-secret';
    const message = `network failure\n    at ${secret}`;
    const getter = vi.fn(() => message);
    const cause = kind === 'DOMException' ? new DOMException(message, 'NetworkError') : new Error();
    if (kind === 'message accessor') Object.defineProperty(cause, 'message', { get: getter });
    if (kind === 'name accessor') Object.defineProperty(cause, 'name', { get: getter });
    if (kind === 'stack accessor') Object.defineProperty(cause, 'stack', { get: getter });
    const { server, id, options, root } = await fixture(() => { throw new TypeError('fetch failed', { cause }); });
    const log = vi.spyOn(options.errorLogger, 'error');

    await run(server, id, 'error');
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'TypeError', detail: 'fetch failed', causes: [expect.objectContaining({
        code: kind === 'DOMException' ? 'DOMException' : 'Error',
      })] }),
    }), 'conversation_run_error');
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(getter).not.toHaveBeenCalled();
    await expect.poll(async () => (await errors(server, id)).length).toBe(1);
    expect((await errors(server, id))[0]).toMatchObject({ code: 'TypeError', detail: 'fetch failed' });
    await closeServer(server);
    expect(await pathContainsPlaintext(root, secret)).toBe(false);
  });

  test('retains native stack frames for an Error cause with no own message property', async () => {
    const { server, id, options } = await fixture(() => { throw new TypeError('fetch failed', { cause: new Error() }); });
    const log = vi.spyOn(options.errorLogger, 'error');
    await run(server, id, 'error');
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ causes: [expect.objectContaining({ code: 'Error', stack_frames: expect.arrayContaining([expect.stringMatching(/^\s+at\s/u)]) })] }),
    }), 'conversation_run_error');
  });

  test.each(['cause', 'aggregate member', 'revoked cause'])('preserves the original failure and continuation with an uninspectable %s', async (kind) => {
    const secret = 'fixture-prototype-trap-secret';
    const trap = vi.fn(() => { throw new Error(secret); });
    let uninspectable: unknown = new Proxy({}, { getPrototypeOf: trap });
    if (kind === 'revoked cause') {
      const revocable = Proxy.revocable({}, {});
      revocable.revoke();
      uninspectable = revocable.proxy;
    }
    const native = Object.assign(new Error('safe native cause'), { code: 'ECONNRESET' });
    const cause = kind === 'aggregate member' ? new AggregateError([uninspectable, native], 'private aggregate') : uninspectable;
    const failure = new TypeError('fetch failed', { cause });
    const factory = vi.fn(() => {
      if (factory.mock.calls.length === 1) throw failure;
      return new Agent({ llm: TestLLM.fromMessages([finish('finish-after-uninspectable-cause')]), tools: [FinishTool.create()] });
    });
    const { server, id, options, root } = await fixture(factory);
    const log = vi.spyOn(options.errorLogger, 'error');

    await run(server, id, 'error');
    await expect.poll(async () => (await errors(server, id)).length).toBe(1);
    const first = (await errors(server, id))[0]!;
    expect(first).toMatchObject({ code: 'TypeError', detail: 'fetch failed' });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'TypeError', detail: 'fetch failed' }),
    }), 'conversation_run_error');
    expect(log).toHaveBeenCalledTimes(1);
    if (kind === 'aggregate member') expect(log).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ causes: [expect.objectContaining({
        code: 'AggregateError', causes: [expect.objectContaining({ system_code: 'ECONNRESET' })],
      })] }),
    }), 'conversation_run_error');
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    await run(server, id, 'finished');
    expect(await errors(server, id)).toEqual([first]);
    expect(factory).toHaveBeenCalledTimes(2);
    await closeServer(server);
    expect(await pathContainsPlaintext(root, secret)).toBe(false);
  });

  test('writes a structured level-50 record when only error-level logging is enabled', async () => {
    const records: Array<Record<string, unknown>> = [];
    const loggerHost = Fastify({ logger: { level: 'error', stream: { write(line: string) {
      records.push(JSON.parse(line) as Record<string, unknown>);
    } } } });
    try {
      const cause = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
      const { server, id } = await fixture(() => { throw new TypeError('fetch failed', { cause }); }, loggerHost.log);
      await run(server, id, 'error');
      expect(records).toEqual([expect.objectContaining({
        level: 50, time: expect.any(Number), pid: expect.any(Number),
        msg: 'conversation_run_error', conversation_id: id,
        error: expect.objectContaining({ causes: [expect.objectContaining({ system_code: 'ECONNRESET' })] }),
      })]);
    } finally {
      await loggerHost.close();
    }
  });

  test('caps wide and deep cause trees and never invokes attached diagnostic getters', async () => {
    const getter = vi.fn(() => { throw new Error('fixture-getter-secret'); });
    const children = Array.from({ length: 30 }, () => Object.assign(new Error('private cause'), { code: 'ECONNRESET' }));
    Object.defineProperty(children[0], 'syscall', { get: getter });
    let cause: Error = new AggregateError(children, 'private aggregate');
    for (let i = 0; i < 20; i += 1) cause = new Error('private wrapper', { cause });
    const { server, id, options } = await fixture(() => { throw new TypeError('fetch failed', { cause: new AggregateError([children[0], cause, ...children], 'private aggregate') }); });
    const log = vi.spyOn(options.errorLogger, 'error');
    await run(server, id, 'error');
    const encoded = JSON.stringify(log.mock.calls);
    expect(encoded).not.toContain('private cause');
    expect(encoded).not.toContain('private wrapper');
    expect(encoded).not.toContain('private aggregate');
    expect(encoded.length).toBeLessThan(16000);
    expect((encoded.match(/stack_frames/gu) ?? []).length).toBeLessThanOrEqual(8);
    expect(getter).not.toHaveBeenCalled();
  });

  test('timestamps lease-renewal failures through the same error logger and identifies their conversation', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const { server, id, options } = await fixture(() => new Agent({ llm: TestLLM.fromMessages([]), tools: [] }));
      const failure = Object.assign(new Error('lock already exists'), { code: 'EEXIST', syscall: 'open' });
      const renew = vi.spyOn(ConversationLease.prototype, 'renew').mockRejectedValue(failure);
      const log = vi.spyOn(options.errorLogger, 'error');
      await vi.advanceTimersByTimeAsync(defaultLeaseTtlMs);
      expect(renew).toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.objectContaining({
        conversation_id: id, error: expect.objectContaining({ system_code: 'EEXIST', syscall: 'open' }),
      }), 'conversation_lease_renew_error');
      await closeServer(server);
    } finally {
      vi.useRealTimers();
    }
  });

  test('makes a factory failure durable before an agent exists and retries factory construction on the next prompt', async () => {
    const factory = vi.fn(() => {
      if (factory.mock.calls.length === 1) throw new TypeError('duplicate tool names');
      return new Agent({ llm: TestLLM.fromMessages([finish('factory-retry')]), tools: [FinishTool.create()] });
    });
    const { server, id } = await fixture(factory);
    await run(server, id, 'error');
    await expect.poll(async () => (await errors(server, id)).length).toBe(1);
    expect((await errors(server, id))[0]).toMatchObject({ code: 'TypeError', detail: 'duplicate tool names',
      classification: { kind: 'internal', retryable: false } });
    await run(server, id, 'finished');
    expect(factory).toHaveBeenCalledTimes(2);
    expect(await errors(server, id)).toHaveLength(1);
  });

  test('publishes an error already appended by the agent without emitting a second backstop event', async () => {
    const existing = conversationErrorEventSchema.parse({ source: 'environment', code: 'LLMTimeoutError', detail: 'timeout' });
    const { server, id } = await fixture(() => {
      const agent = new Agent({ llm: TestLLM.fromMessages([]), tools: [FinishTool.create()] });
      agent.step = async (state) => {
        await state.appendEventAsync(existing);
        throw new Error('already surfaced');
      };
      return agent;
    });
    const emitted: Event[] = [];
    const service = (await server.conversationService.getEventService(id))!;
    await service.subscribeToEvents((event) => { emitted.push(event); });
    await run(server, id, 'error');
    expect(await errors(server, id)).toEqual([existing]);
    await expect.poll(() => emitted.filter((event) => event.kind === 'ConversationErrorEvent')).toEqual([existing]);
  });

  test('does not serialize arbitrary thrown objects into the event or logs', async () => {
    const secret = 'fixture-arbitrary-thrown-object-secret';
    const { server, id, root, options } = await fixture(() => { throw { token: secret, toString: () => secret }; });
    const log = vi.spyOn(options.errorLogger, 'error');

    await run(server, id, 'error');
    await expect.poll(async () => (await errors(server, id)).length).toBe(1);
    expect((await errors(server, id))[0]).toMatchObject({ code: 'Error', detail: 'Conversation run failed.' });
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    await closeServer(server);
    expect(await pathContainsPlaintext(root, secret)).toBe(false);
  });
});
