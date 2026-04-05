import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentServerApp } from "./app.js";
import { createAgentServerDeps } from "./dependencies.js";

type JsonRecord = Record<string, unknown>;

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonLines(filePath: string, values: unknown[]): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    values.map((value) => JSON.stringify(value)).join("\n").concat("\n"),
  );
}

function seedConversation(
  persistenceRoot: string,
  conversationId: string,
  options: {
    meta?: JsonRecord;
    events?: JsonRecord[];
    turns?: JsonRecord;
    outbox?: JsonRecord[];
    taskCommands?: JsonRecord[];
  },
): void {
  const conversationDir = path.join(persistenceRoot, conversationId);
  mkdirSync(conversationDir, { recursive: true });
  if (options.meta) {
    writeJson(path.join(conversationDir, "meta.json"), options.meta);
  }
  if (options.events) {
    writeJsonLines(path.join(conversationDir, "events.jsonl"), options.events);
  }
  if (options.turns) {
    writeJson(path.join(conversationDir, "turns.json"), options.turns);
  }
  if (options.outbox) {
    writeJsonLines(path.join(conversationDir, "outbox.jsonl"), options.outbox);
  }
  if (options.taskCommands) {
    writeJsonLines(
      path.join(conversationDir, "task-commands.jsonl"),
      options.taskCommands,
    );
  }
}

test("GET /api/activity marks persisted running turns as stuck", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "smolpaws-activity-"));
  const persistenceRoot = path.join(tempRoot, "conversations");
  const now = new Date("2026-04-06T00:30:00.000Z");
  const earlier = new Date("2026-04-06T00:29:00.000Z");

  seedConversation(persistenceRoot, "github-smolpaws-smolpaws-76", {
    meta: {
      title: "Issue 76",
      smolpaws: {
        ingress: "github_webhook",
        github: {
          repository_full_name: "smolpaws/smolpaws",
          issue_number: 76,
          actor_login: "enyst",
        },
      },
    },
    events: [
      {
        kind: "MessageEvent",
        id: "user-1",
        source: "user",
        timestamp: earlier.toISOString(),
        llm_message: {
          role: "user",
          content: [{ type: "text", text: "@smolpaws can you check this?" }],
        },
      },
      {
        kind: "MessageEvent",
        id: "assistant-1",
        source: "agent",
        timestamp: new Date(earlier.getTime() + 1000).toISOString(),
        llm_message: {
          role: "assistant",
          content: [{ type: "text", text: "Checking the worker flow now." }],
        },
      },
      {
        kind: "ActionEvent",
        id: "action-1",
        source: "agent",
        timestamp: new Date(earlier.getTime() + 2000).toISOString(),
        tool_name: "terminal",
        action: { command: "git status" },
      },
      {
        kind: "ConversationStateUpdateEvent",
        id: "state-1",
        source: "agent",
        timestamp: now.toISOString(),
        agent_status: "RUNNING",
      },
    ],
    turns: {
      next_sequence: 2,
      turns: [
        {
          id: "turn-1",
          sequence: 1,
          status: "running",
          started_at: earlier.toISOString(),
          updated_at: now.toISOString(),
          messages: [
            {
              id: "msg-1",
              idempotency_key: "delivery-1",
              accepted_at: earlier.toISOString(),
              content: [{ type: "text", text: "@smolpaws can you check this?" }],
            },
          ],
        },
      ],
    },
    outbox: [
      {
        turn_id: "turn-1",
        payload: { kind: "current_thread_message", text: "Still checking..." },
      },
    ],
    taskCommands: [
      {
        turn_id: "turn-1",
        payload: {
          kind: "schedule_task",
          prompt: "Check again later",
          schedule_type: "once",
          schedule_value: "2026-04-07T10:00:00Z",
          context_mode: "isolated",
        },
      },
    ],
  });

  seedConversation(persistenceRoot, "whatsapp-main", {
    meta: {
      title: "WhatsApp main",
      smolpaws: {
        ingress: "whatsapp",
        scope_id: "main",
      },
    },
    events: [
      {
        kind: "MessageEvent",
        id: "user-2",
        source: "user",
        timestamp: new Date(earlier.getTime() - 60_000).toISOString(),
        llm_message: {
          role: "user",
          content: [{ type: "text", text: "hey from whatsapp" }],
        },
      },
      {
        kind: "ConversationStateUpdateEvent",
        id: "state-2",
        source: "agent",
        timestamp: new Date(earlier.getTime() - 30_000).toISOString(),
        agent_status: "IDLE",
      },
    ],
    turns: {
      next_sequence: 2,
      turns: [
        {
          id: "turn-2",
          sequence: 1,
          status: "completed",
          started_at: new Date(earlier.getTime() - 60_000).toISOString(),
          updated_at: new Date(earlier.getTime() - 30_000).toISOString(),
          completed_at: new Date(earlier.getTime() - 30_000).toISOString(),
          messages: [
            {
              id: "msg-2",
              idempotency_key: "delivery-2",
              accepted_at: new Date(earlier.getTime() - 60_000).toISOString(),
              content: [{ type: "text", text: "hey from whatsapp" }],
            },
          ],
        },
      ],
    },
  });

  seedConversation(persistenceRoot, "plain-openhands-thread", {
    events: [
      {
        kind: "ConversationStateUpdateEvent",
        id: "state-plain",
        source: "agent",
        timestamp: new Date(now.getTime() + 10_000).toISOString(),
        agent_status: "RUNNING",
      },
    ],
  });

  const deps = createAgentServerDeps({
    SMOLPAWS_PERSISTENCE_DIR: persistenceRoot,
    SMOLPAWS_RUNNER_TOKEN: "secret-token",
    SMOLPAWS_WORKSPACE_ROOT: tempRoot,
  });
  const { app } = await createAgentServerApp(deps);

  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/activity?limit=10",
      headers: {
        authorization: "Bearer secret-token",
      },
    });
    assert.equal(response.statusCode, 200);
    const payload = JSON.parse(response.body) as {
      items: Array<Record<string, unknown>>;
      summary: Record<string, number>;
    };

    assert.equal(payload.summary.total_conversations, 2);
    assert.equal(payload.summary.running_count, 0);
    assert.equal(payload.summary.stuck_count, 1);
    assert.equal(payload.summary.pending_outbound_count, 1);

    const githubItem = payload.items.find(
      (item) => item.id === "github-smolpaws-smolpaws-76",
    );
    assert(githubItem);
    assert.equal(githubItem.ingress, "github_webhook");
    assert.equal(githubItem.target, "smolpaws/smolpaws#76");
    assert.equal(githubItem.execution_status, "stuck");
    assert.equal(githubItem.is_live, false);
    assert.equal(githubItem.pending_outbound_count, 1);
    assert.equal(githubItem.pending_task_command_count, 1);
    assert.equal(
      (githubItem.latest_turn as Record<string, unknown>).status,
      "stuck",
    );
    assert.match(String(githubItem.latest_action), /^terminal: git status/);
    assert.equal(
      githubItem.last_user_message,
      "@smolpaws can you check this?",
    );

    const whatsappItem = payload.items.find((item) => item.id === "whatsapp-main");
    assert(whatsappItem);
    assert.equal(whatsappItem.ingress, "whatsapp");
    assert.equal(whatsappItem.target, "main");
    assert.equal(whatsappItem.execution_status, "completed");
    assert.equal(
      payload.items.some((item) => item.id === "plain-openhands-thread"),
      false,
    );
  } finally {
    await app.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("GET /api/activity keeps live running conversations marked as running", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "smolpaws-activity-"));
  const persistenceRoot = path.join(tempRoot, "conversations");
  const now = new Date("2026-04-06T01:00:00.000Z");
  const deps = createAgentServerDeps({
    SMOLPAWS_PERSISTENCE_DIR: persistenceRoot,
    SMOLPAWS_RUNNER_TOKEN: "secret-token",
    SMOLPAWS_WORKSPACE_ROOT: tempRoot,
  });

  deps.conversationRuntime.conversations.set("github-live", {
    id: "github-live",
    createdAt: new Date(now.getTime() - 60_000).toISOString(),
    updatedAt: now.toISOString(),
    title: "Live GitHub thread",
    conversation: {} as never,
    events: [
      {
        kind: "MessageEvent",
        id: "user-live",
        source: "user",
        timestamp: new Date(now.getTime() - 30_000).toISOString(),
        llm_message: {
          role: "user",
          content: [{ type: "text", text: "@smolpaws still working?" }],
        },
      },
      {
        kind: "ConversationStateUpdateEvent",
        id: "state-live",
        source: "agent",
        timestamp: now.toISOString(),
        agent_status: "RUNNING",
      },
    ] as never,
    settings: {} as never,
    secrets: {} as never,
    workspaceRoot: tempRoot,
    smolpaws: {
      ingress: "github_webhook",
      github: {
        repository_full_name: "smolpaws/smolpaws",
        issue_number: 80,
      },
    },
  });
  deps.conversationRuntime.turnStates.set("github-live", {
    next_sequence: 2,
    turns: [
      {
        id: "turn-live",
        sequence: 1,
        status: "running",
        started_at: new Date(now.getTime() - 30_000).toISOString(),
        updated_at: now.toISOString(),
        messages: [
          {
            id: "message-live",
            idempotency_key: "delivery-live",
            accepted_at: new Date(now.getTime() - 30_000).toISOString(),
            content: [{ type: "text", text: "@smolpaws still working?" }],
          },
        ],
      },
    ],
  });

  const { app } = await createAgentServerApp(deps);

  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/activity?limit=10",
      headers: {
        authorization: "Bearer secret-token",
      },
    });
    assert.equal(response.statusCode, 200);
    const payload = JSON.parse(response.body) as {
      items: Array<Record<string, unknown>>;
      summary: Record<string, number>;
    };

    const liveItem = payload.items.find((item) => item.id === "github-live");
    assert(liveItem);
    assert.equal(liveItem.execution_status, "running");
    assert.equal(liveItem.is_live, true);
    assert.equal(
      (liveItem.latest_turn as Record<string, unknown>).status,
      "running",
    );
    assert.equal(payload.summary.running_count, 1);
    assert.equal(payload.summary.stuck_count, 0);
  } finally {
    await app.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("GET /api/activity skips malformed queue lines and reuses a hot snapshot", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "smolpaws-activity-"));
  const persistenceRoot = path.join(tempRoot, "conversations");
  const now = new Date("2026-04-06T01:10:00.000Z");

  seedConversation(persistenceRoot, "github-smolpaws-smolpaws-81", {
    meta: {
      title: "Issue 81",
      smolpaws: {
        ingress: "github_webhook",
        github: {
          repository_full_name: "smolpaws/smolpaws",
          issue_number: 81,
        },
      },
    },
    events: [
      {
        kind: "ConversationStateUpdateEvent",
        id: "state-81",
        source: "agent",
        timestamp: now.toISOString(),
        agent_status: "IDLE",
      },
    ],
    outbox: [
      {
        turn_id: "turn-81",
        payload: { kind: "current_thread_message", text: "queued" },
      },
    ],
  });
  appendFileSync(
    path.join(persistenceRoot, "github-smolpaws-smolpaws-81", "outbox.jsonl"),
    "{ definitely not json }\n",
  );

  const deps = createAgentServerDeps({
    SMOLPAWS_PERSISTENCE_DIR: persistenceRoot,
    SMOLPAWS_RUNNER_TOKEN: "secret-token",
    SMOLPAWS_WORKSPACE_ROOT: tempRoot,
  });
  const { app } = await createAgentServerApp(deps);

  try {
    const headers = {
      authorization: "Bearer secret-token",
    };
    const first = await app.inject({
      method: "GET",
      url: "/api/activity?limit=10",
      headers,
    });
    const second = await app.inject({
      method: "GET",
      url: "/api/activity?limit=10",
      headers,
    });

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);

    const firstPayload = JSON.parse(first.body) as {
      server_time: string;
      items: Array<Record<string, unknown>>;
    };
    const secondPayload = JSON.parse(second.body) as {
      server_time: string;
      items: Array<Record<string, unknown>>;
    };

    assert.equal(firstPayload.server_time, secondPayload.server_time);
    const item = firstPayload.items.find(
      (entry) => entry.id === "github-smolpaws-smolpaws-81",
    );
    assert(item);
    assert.equal(item.pending_outbound_count, 1);
  } finally {
    await app.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("GET /api/activity summary covers all smolpaws conversations beyond the visible limit", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "smolpaws-activity-"));
  const persistenceRoot = path.join(tempRoot, "conversations");
  const now = new Date("2026-04-06T01:20:00.000Z");

  seedConversation(persistenceRoot, "github-smolpaws-smolpaws-90", {
    meta: {
      title: "Issue 90",
      smolpaws: {
        ingress: "github_webhook",
        github: {
          repository_full_name: "smolpaws/smolpaws",
          issue_number: 90,
        },
      },
    },
    events: [
      {
        kind: "ConversationStateUpdateEvent",
        id: "state-90",
        source: "agent",
        timestamp: now.toISOString(),
        agent_status: "RUNNING",
      },
    ],
    turns: {
      next_sequence: 2,
      turns: [
        {
          id: "turn-90",
          sequence: 1,
          status: "running",
          started_at: new Date(now.getTime() - 5_000).toISOString(),
          updated_at: now.toISOString(),
          messages: [
            {
              id: "msg-90",
              idempotency_key: "delivery-90",
              accepted_at: new Date(now.getTime() - 5_000).toISOString(),
              content: [{ type: "text", text: "@smolpaws are you there?" }],
            },
          ],
        },
      ],
    },
    outbox: [
      {
        turn_id: "turn-90",
        payload: { kind: "current_thread_message", text: "Still working..." },
      },
    ],
  });

  seedConversation(persistenceRoot, "whatsapp-summary-main", {
    meta: {
      title: "WhatsApp summary",
      smolpaws: {
        ingress: "whatsapp",
        scope_id: "main",
      },
    },
    events: [
      {
        kind: "ConversationStateUpdateEvent",
        id: "state-summary",
        source: "agent",
        timestamp: new Date(now.getTime() - 60_000).toISOString(),
        agent_status: "IDLE",
      },
    ],
  });

  const deps = createAgentServerDeps({
    SMOLPAWS_PERSISTENCE_DIR: persistenceRoot,
    SMOLPAWS_RUNNER_TOKEN: "secret-token",
    SMOLPAWS_WORKSPACE_ROOT: tempRoot,
  });
  const { app } = await createAgentServerApp(deps);

  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/activity?limit=1",
      headers: {
        authorization: "Bearer secret-token",
      },
    });
    assert.equal(response.statusCode, 200);
    const payload = JSON.parse(response.body) as {
      items: Array<Record<string, unknown>>;
      summary: Record<string, number>;
    };

    assert.equal(payload.items.length, 1);
    assert.equal(payload.summary.total_conversations, 2);
    assert.equal(payload.summary.running_count, 0);
    assert.equal(payload.summary.stuck_count, 1);
    assert.equal(payload.summary.pending_outbound_count, 1);
    assert.equal(payload.items[0]?.id, "github-smolpaws-smolpaws-90");
  } finally {
    await app.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("GET /api/activity requires authorization when a runner token is configured", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "smolpaws-activity-"));
  const deps = createAgentServerDeps({
    SMOLPAWS_PERSISTENCE_DIR: path.join(tempRoot, "conversations"),
    SMOLPAWS_RUNNER_TOKEN: "secret-token",
    SMOLPAWS_WORKSPACE_ROOT: tempRoot,
  });
  const { app } = await createAgentServerApp(deps);

  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/activity",
    });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("GET /activity serves the operator page", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "smolpaws-activity-"));
  const deps = createAgentServerDeps({
    SMOLPAWS_PERSISTENCE_DIR: path.join(tempRoot, "conversations"),
    SMOLPAWS_WORKSPACE_ROOT: tempRoot,
  });
  const { app } = await createAgentServerApp(deps);

  try {
    const response = await app.inject({
      method: "GET",
      url: "/activity",
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /SmolPaws Activity/);
    assert.match(response.body, /\/api\/activity/);
    assert.match(response.body, /&quot;/);
    assert.match(response.body, /&#39;/);
  } finally {
    await app.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
