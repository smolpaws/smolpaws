import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAgentServerApp } from '../../../../packages/openhands-agent-server/src/app.js';
import { buildPrompt } from '../handler.js';

test('an inbound WhatsApp image is accepted and preserved by the real agent-server', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'whatsapp-image-contract-'));
  const imagePath = path.join(root, 'image.png');
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aIl8AAAAASUVORK5CYII=', 'base64');
  writeFileSync(imagePath, image);
  let agentCalls = 0;
  const { app } = await createAgentServerApp({
    // Exercise the real HTTP validation and persistence without a provider call or machine secrets.
    agentFactory: async () => {
      agentCalls += 1;
      throw new Error('image_contract_test_must_not_run_agent');
    },
    secretStore: {
      get: async () => null,
      set: async () => undefined,
      delete: async () => undefined,
      has: async () => false,
    },
    config: {
      conversationsPath: path.join(root, 'conversations'),
      statePath: path.join(root, 'server-state'),
      bashEventsPath: path.join(root, 'bash-events'),
      bashEventsRetentionSeconds: null,
      workspaceRoot: root,
      allowedFileRoots: [root],
      sessionApiKey: null,
    },
  });
  try {
    const prompt = await buildPrompt([{
      seq: 1,
      id: 'image-message',
      chat_jid: 'test@g.us',
      sender: 'test@s.whatsapp.net',
      sender_name: 'Test user',
      content: 'What is in this image?',
      timestamp: '2026-09-17T00:00:00.000Z',
      is_from_me: 0,
      media_path: imagePath,
      media_type: 'image/png', command_eligible: 0,
    }], { maxImageBytes: 1024 });
    const start = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { workspace: { kind: 'LocalWorkspace', working_dir: root } },
    });
    assert.equal(start.statusCode, 201, start.body);
    const conversationId = start.json<{ id: string }>().id;
    const eventId = '11111111-1111-4111-8111-111111111111';
    const append = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/events`,
      payload: { event_id: eventId, role: 'user', content: prompt.content, run: false },
    });
    assert.equal(append.statusCode, 200, append.body);

    const saved = await app.inject(`/api/conversations/${conversationId}/events/${eventId}`);
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual(saved.json().llm_message.content, [
      { type: 'text', text: prompt.text, cache_prompt: false },
      { type: 'image', image_urls: [`data:image/png;base64,${image.toString('base64')}`], cache_prompt: false },
    ]);
    assert.equal(agentCalls, 0);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
