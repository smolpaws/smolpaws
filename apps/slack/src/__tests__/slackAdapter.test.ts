import assert from 'node:assert/strict';
import { createServer, type IncomingMessage as HttpIncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import {
  type IncomingMessage,
  type ReplyContext,
} from '../../../../src/shared/bridgeAdapter.js';
import { SlackAdapter } from '../adapter.js';
import type { SlackConfig } from '../config.js';

function makeSlackConfig(): SlackConfig {
  return {
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    allowedTeamIds: new Set(),
    allowedChannelIds: new Set(),
    allowedUserIds: new Set(),
    logLevel: 'silent',
  };
}

class TestSlackAdapter extends SlackAdapter {
  async dispatchMessage(message: IncomingMessage, replyContext: ReplyContext): Promise<void> {
    await this.dispatch(message, replyContext);
  }

  async sendReplyForTest(replyContext: ReplyContext, text: string): Promise<void> {
    await this.sendReply(replyContext, text);
  }
}

type PostedMessage = {
  channel: string;
  text: string;
  thread_ts?: string;
  unfurl_links?: boolean;
  unfurl_media?: boolean;
};

async function readJson(req: HttpIncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res: ServerResponse, value: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

async function withAgentServer(
  outboundMessages: Array<{ kind: 'current_thread_message'; text: string }>,
  reply: string | undefined,
  run: (baseUrl: string, requests: unknown[]) => Promise<void>,
  isDeliveryOwner = true,
): Promise<void> {
  const requests: unknown[] = [];
  const server = createServer(async (req, res) => {
    const url = req.url ?? '';
    if (req.method === 'POST' && /\/turns$/.test(url)) {
      requests.push(await readJson(req));
      sendJson(res, {
        conversation_id: 'slack-thread-T06P-C123-100.001',
        turn_id: 'turn-1',
        message_event_id: 'message-1',
        started_new_turn: true,
        status: 'running',
        is_delivery_owner: isDeliveryOwner,
      }, 201);
      return;
    }
    if (req.method === 'GET' && /\/turns\/turn-1\?/.test(url)) {
      sendJson(res, {
        conversation_id: 'slack-thread-T06P-C123-100.001',
        turn_id: 'turn-1',
        status: 'completed',
        started_at: '2026-07-13T00:00:00.000Z',
        updated_at: '2026-07-13T00:00:01.000Z',
        completed_at: '2026-07-13T00:00:01.000Z',
        is_delivery_owner: isDeliveryOwner,
      });
      return;
    }
    if (req.method === 'POST' && url.endsWith('/outbound_messages/claim')) {
      sendJson(res, outboundMessages.splice(0));
      return;
    }
    if (req.method === 'GET' && url.endsWith('/result')) {
      sendJson(res, {
        conversation_id: 'slack-thread-T06P-C123-100.001',
        turn_id: 'turn-1',
        status: 'completed',
        ...(reply ? { reply } : {}),
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, requests);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function makeAdapter(baseUrl: string, posted: PostedMessage[]): TestSlackAdapter {
  const adapter = new TestSlackAdapter({
    name: 'slack',
    runnerUrl: baseUrl,
    runnerToken: 'runner-secret',
    logger: pino({ level: 'silent' }),
    slackConfig: makeSlackConfig(),
  });
  (adapter as unknown as { app: unknown }).app = {
    client: {
      chat: {
        postMessage: async (message: PostedMessage) => { posted.push(message); },
      },
    },
  };
  return adapter;
}

function incomingMessage(): IncomingMessage {
  return {
    conversationId: 'slack-thread-T06P-C123-100.001',
    prompt: 'please help',
    messageId: 'C123:100.002',
    platformContext: {
      team_id: 'T06P',
      channel_id: 'C123',
      user_id: 'U456',
      thread_ts: '100.001',
    },
  };
}

const replyContext: ReplyContext = {
  original: { channelId: 'C123', ts: '100.002', threadTs: '100.001' },
  conversationId: 'slack-thread-T06P-C123-100.001',
};

test('SlackAdapter ignores malformed reply contexts safely', async () => {
  const posted: PostedMessage[] = [];
  const adapter = makeAdapter('http://127.0.0.1:1', posted);

  await assert.doesNotReject(
    adapter.sendReplyForTest({ original: undefined, conversationId: 'slack-invalid' }, 'reply'),
  );

  assert.equal(posted.length, 0);
});

test('SlackAdapter uses BaseBridgeAdapter dispatch and nests Slack create metadata', async () => {
  await withAgentServer([], 'final answer', async (baseUrl, requests) => {
    const posted: PostedMessage[] = [];
    const adapter = makeAdapter(baseUrl, posted);

    await adapter.dispatchMessage(incomingMessage(), replyContext);

    assert.equal(posted.length, 1);
    assert.equal(posted[0].channel, 'C123');
    assert.equal(posted[0].text, 'final answer');
    assert.equal(posted[0].thread_ts, '100.001');
    assert.equal(posted[0].unfurl_links, false);
    assert.equal(posted[0].unfurl_media, false);
    const body = requests[0] as {
      idempotency_key: string;
      create_conversation: { smolpaws: Record<string, unknown> };
    };
    assert.equal(body.idempotency_key, 'C123:100.002');
    assert.equal(body.create_conversation.smolpaws.ingress, 'slack');
    assert.deepEqual(body.create_conversation.smolpaws.slack, incomingMessage().platformContext);
    assert.equal('team_id' in body.create_conversation.smolpaws, false);
  });
});

test('SlackAdapter delivers send_message output and suppresses duplicate final fallback', async () => {
  await withAgentServer(
    [
      { kind: 'current_thread_message', text: 'progress 1' },
      { kind: 'current_thread_message', text: 'progress 2' },
    ],
    'final answer',
    async (baseUrl) => {
      const posted: PostedMessage[] = [];
      const adapter = makeAdapter(baseUrl, posted);

      await adapter.dispatchMessage(incomingMessage(), replyContext);

      assert.equal(posted.length, 2);
      assert.equal(posted[0].text, 'progress 1');
      assert.equal(posted[1].text, 'progress 2');
      assert.equal(posted[0].thread_ts, '100.001');
      assert.equal(posted[1].thread_ts, '100.001');
    },
  );
});

test('SlackAdapter does not deliver a fallback when it is not the delivery owner', async () => {
  await withAgentServer([], undefined, async (baseUrl) => {
    const posted: PostedMessage[] = [];
    const adapter = makeAdapter(baseUrl, posted);

    await adapter.dispatchMessage(incomingMessage(), replyContext);

    assert.equal(posted.length, 0);
  }, false);
});

test('SlackAdapter posts the shared no-output final fallback', async () => {
  await withAgentServer([], undefined, async (baseUrl) => {
    const posted: PostedMessage[] = [];
    const adapter = makeAdapter(baseUrl, posted);

    await adapter.dispatchMessage(incomingMessage(), replyContext);

    assert.equal(posted.length, 1);
    assert.equal(posted[0].text, '🐾 Done — nothing to report back.');
  });
});
