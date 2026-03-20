import { Daytona, type Sandbox } from "@daytonaio/sdk";
import { Value } from "@sinclair/typebox/value";
import type {
  SmolpawsRunnerRequest,
  SmolpawsRunnerResponse,
} from "./shared/runner.js";
import { SmolpawsRunnerResponseSchema } from "./shared/runner.js";

const AGENT_SDK_VERSION = "@smolpaws/agent-sdk@0.9.2";
const RESPONSE_MARKER = "__SMOLPAWS_RESPONSE__";

export type DaytonaEnv = {
  DAYTONA_API_KEY?: string;
  DAYTONA_API_URL?: string;
  DAYTONA_TARGET?: string;
  SMOLPAWS_DAYTONA_AUTO_STOP_MINUTES?: string;
};

export type DaytonaLlmConfig = {
  model: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
};

type PullRequestContext = {
  number: number;
  headRef: string;
  headRepoFullName: string;
};

type RepoContext = {
  fullName: string;
  ref?: string;
};

type DaytonaRunParams = {
  env: DaytonaEnv;
  message: SmolpawsRunnerRequest;
  prompt: string;
  llm: DaytonaLlmConfig;
  persistenceDir?: string;
};

type DaytonaRunResult = SmolpawsRunnerResponse & {
  mode: "per_pr" | "per_job";
};

const cachedSandboxes = new Map<string, Sandbox>();
let daytonaClient: Daytona | null = null;

function extractMarkedResponse(output: string): string | null {
  const markedLine = output
    .split("\n")
    .find((line) => line.trim().startsWith(RESPONSE_MARKER));
  if (!markedLine) {
    return null;
  }
  return markedLine.trim().slice(RESPONSE_MARKER.length).trim();
}

export async function maybeRunInDaytona(
  params: DaytonaRunParams,
): Promise<DaytonaRunResult | null> {
  const client = getDaytonaClient(params.env);
  if (!client) return null;

  const repoFullName = params.message.github?.payload.repository?.full_name;
  const issueNumber =
    params.message.github?.payload.pull_request?.number ??
    params.message.github?.payload.issue?.number;

  if (!repoFullName || !issueNumber) {
    return null;
  }

  if (!params.message.github?.token) {
    return null;
  }

  const prContext = await resolvePullRequestContext({
    repoFullName,
    issueNumber,
    token: params.message.github.token,
  });

  const reuseKey = prContext
    ? `pr:${prContext.headRepoFullName}#${prContext.number}`
    : null;
  const mode: DaytonaRunResult["mode"] = prContext ? "per_pr" : "per_job";

  const sandbox = await getSandbox({
    client,
    reuseKey,
    autoStopMinutes: parseAutoStopMinutes(params.env),
  });

  try {
    const repo: RepoContext = prContext
      ? {
          fullName: prContext.headRepoFullName,
          ref: prContext.headRef,
        }
      : { fullName: repoFullName };

    const workspaceRoot = await ensureWorkspace({
      sandbox,
      repo,
      token: params.message.github.token,
    });

    const result = await runAgentInSandbox({
      sandbox,
      prompt: params.prompt,
      workspaceRoot,
      llm: params.llm,
      persistenceDir: params.persistenceDir,
    });

    return { ...result, mode };
  } finally {
    if (!reuseKey) {
      await sandbox.delete();
    }
  }
}

function getDaytonaClient(env: DaytonaEnv): Daytona | null {
  if (!env.DAYTONA_API_KEY) {
    return null;
  }
  if (!daytonaClient) {
    daytonaClient = new Daytona({
      apiKey: env.DAYTONA_API_KEY,
      apiUrl: env.DAYTONA_API_URL,
      target: env.DAYTONA_TARGET,
    });
  }
  return daytonaClient;
}

async function getSandbox(options: {
  client: Daytona;
  reuseKey: string | null;
  autoStopMinutes: number;
}): Promise<Sandbox> {
  if (options.reuseKey) {
    const cached = cachedSandboxes.get(options.reuseKey);
    if (cached) {
      return cached;
    }
  }

  const sandbox = await options.client.create({
    language: "typescript",
    autoStopInterval: options.autoStopMinutes,
  });

  if (options.reuseKey) {
    cachedSandboxes.set(options.reuseKey, sandbox);
  }

  return sandbox;
}

function parseAutoStopMinutes(env: DaytonaEnv): number {
  const raw = env.SMOLPAWS_DAYTONA_AUTO_STOP_MINUTES ?? "30";
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 30;
  }
  return Math.trunc(parsed);
}

async function resolvePullRequestContext(options: {
  repoFullName: string;
  issueNumber: number;
  token?: string;
}): Promise<PullRequestContext | null> {
  if (!options.token) return null;

  const response = await fetch(
    `https://api.github.com/repos/${options.repoFullName}/pulls/${options.issueNumber}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${options.token}`,
        "User-Agent": "smolpaws-runner",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Failed to fetch PR details: ${message}`);
  }

  const data = (await response.json()) as {
    number?: number;
    head?: { ref?: string; repo?: { full_name?: string } };
  };

  const number = data.number ?? options.issueNumber;
  const headRef = data.head?.ref;
  const headRepoFullName = data.head?.repo?.full_name;

  if (!headRef || !headRepoFullName) {
    return null;
  }

  return { number, headRef, headRepoFullName };
}

async function ensureWorkspace(options: {
  sandbox: Sandbox;
  repo: RepoContext;
  token?: string;
}): Promise<string> {
  if (!options.token) {
    throw new Error("GitHub token is required for Daytona workspace clone");
  }

  const repoSlug = sanitizeRepoName(options.repo.fullName);
  const repoDir = `/workspace/repos/${repoSlug}`;
  const cloneUrl = buildCloneUrl(options.repo.fullName, options.token);

  await execShell(options.sandbox, "mkdir -p /workspace/repos");

  await execShell(
    options.sandbox,
    `if [ ! -d "${repoDir}/.git" ]; then git clone "${cloneUrl}" "${repoDir}"; fi`,
  );

  if (options.repo.ref) {
    const ref = options.repo.ref;
    await execShell(
      options.sandbox,
      `git -C "${repoDir}" fetch origin "${ref}"`,
    );
    await execShell(
      options.sandbox,
      `git -C "${repoDir}" checkout -B "${ref}" "origin/${ref}"`,
    );
  } else {
    await execShell(options.sandbox, `git -C "${repoDir}" fetch origin`);
  }

  return repoDir;
}

async function runAgentInSandbox(options: {
  sandbox: Sandbox;
  prompt: string;
  workspaceRoot: string;
  llm: DaytonaLlmConfig;
  persistenceDir?: string;
}): Promise<SmolpawsRunnerResponse> {
  const agentDir = "/workspace/smolpaws-agent";
  const scriptPath = `${agentDir}/run-agent.mjs`;

  await execShell(options.sandbox, `mkdir -p "${agentDir}"`);
  await execShell(
    options.sandbox,
    `if [ ! -d "${agentDir}/node_modules" ]; then cd "${agentDir}" && npm init -y >/dev/null 2>&1 && npm install ${AGENT_SDK_VERSION} >/dev/null 2>&1; fi`,
  );

  const script = buildAgentScript();
  await execShell(
    options.sandbox,
    `cat <<'EOF' > "${scriptPath}"
${script}
EOF`,
  );

  const envVars = buildEnvVars({
    prompt: options.prompt,
    workspaceRoot: options.workspaceRoot,
    llm: options.llm,
    persistenceDir: options.persistenceDir,
  });

  const output = await execShell(
    options.sandbox,
    `cd "${agentDir}" && ${envVars} node "${scriptPath}"`,
  );

  const payload = extractMarkedResponse(output);
  if (payload !== null) {
    try {
      const parsed = JSON.parse(payload);
      if (!Value.Check(SmolpawsRunnerResponseSchema, parsed)) {
        throw new Error("Invalid runner response payload from sandbox");
      }
      return {
        reply: parsed.reply ?? "",
        outbound_messages: parsed.outbound_messages,
      };
    } catch {
      return { reply: payload };
    }
  }

  return { reply: output.trim() };
}

function buildAgentScript(): string {
  return `import {
  LocalConversation,
  Workspace,
  SecretRegistry,
  reduceTextContent,
} from "@smolpaws/agent-sdk";

const prompt = process.env.SMOLPAWS_PROMPT ?? "";
const model = process.env.LLM_MODEL ?? "";
if (!model) {
  throw new Error("LLM model is required");
}

const settings = {
  llm: {
    provider: process.env.LLM_PROVIDER || undefined,
    model,
    baseUrl: process.env.LLM_BASE_URL || undefined,
  },
  agent: {
    enableSecurityAnalyzer: false,
    debug: false,
    summarizeToolCalls: false,
  },
  conversation: {
    maxIterations: 50,
    stuckDetection: true,
  },
  confirmation: {
    policy: "never",
    riskyThreshold: "HIGH",
    confirmUnknown: true,
  },
  secrets: {
    llmApiKey: process.env.LLM_API_KEY || undefined,
  },
};

const registry = new SecretRegistry();
const workspaceRoot = process.env.SMOLPAWS_WORKSPACE_ROOT || process.cwd();
const outboundMessages = [];
const sendMessageTool = {
  name: "send_message",
  description:
    "Send a message to the current ingress thread. For GitHub, this posts a comment on the current issue or pull request.",
  parameters: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The message text to send to the current thread.",
      },
    },
    required: ["text"],
    additionalProperties: false,
  },
  validate(input) {
    if (!input || typeof input !== "object") {
      throw new Error("send_message requires an object argument");
    }
    const text = typeof input === "object" && input !== null ? input.text : undefined;
    if (typeof text !== "string" || !text.trim()) {
      throw new Error("send_message requires a non-empty text field");
    }
    return { text: text.trim() };
  },
  async execute(args) {
    outboundMessages.push({
      kind: "current_thread_message",
      text: args.text,
    });
    return { message: "Message queued for delivery to the current thread." };
  },
};
const conversation = new LocalConversation({
  settings,
  workspace: Workspace({ kind: "local", root: workspaceRoot }),
  secrets: registry,
  tools: [sendMessageTool],
  includeDefaultTools: true,
  persistenceDir: process.env.SMOLPAWS_PERSISTENCE_DIR || undefined,
});

let response = "";
conversation.on("event", (event) => {
  if (event.kind === "MessageEvent" && event.llm_message?.role === "assistant") {
    const content = event.llm_message.content || [];
    response = reduceTextContent({ role: "assistant", content }).trim();
  }
});

await conversation.sendUserMessage(prompt);
console.log("${RESPONSE_MARKER}" + JSON.stringify({
  reply: response,
  outbound_messages: outboundMessages.length ? outboundMessages : undefined,
}));
`;
}

function buildEnvVars(options: {
  prompt: string;
  workspaceRoot: string;
  llm: DaytonaLlmConfig;
  persistenceDir?: string;
}): string {
  const entries: string[] = [
    `SMOLPAWS_PROMPT=${shellEscape(options.prompt)}`,
    `SMOLPAWS_WORKSPACE_ROOT=${shellEscape(options.workspaceRoot)}`,
    `LLM_MODEL=${shellEscape(options.llm.model)}`,
  ];

  if (options.llm.provider) {
    entries.push(`LLM_PROVIDER=${shellEscape(options.llm.provider)}`);
  }
  if (options.llm.baseUrl) {
    entries.push(`LLM_BASE_URL=${shellEscape(options.llm.baseUrl)}`);
  }
  if (options.llm.apiKey) {
    entries.push(`LLM_API_KEY=${shellEscape(options.llm.apiKey)}`);
  }
  if (options.persistenceDir) {
    entries.push(
      `SMOLPAWS_PERSISTENCE_DIR=${shellEscape(options.persistenceDir)}`,
    );
  }

  return entries.join(" ");
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sanitizeRepoName(fullName: string): string {
  return fullName.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

function buildCloneUrl(fullName: string, token: string): string {
  const safeToken = encodeURIComponent(token);
  return `https://x-access-token:${safeToken}@github.com/${fullName}.git`;
}

async function execShell(sandbox: Sandbox, command: string): Promise<string> {
  const result = await sandbox.process.executeCommand(
    `bash -lc ${shellEscape(command)}`,
  );
  if (typeof result.exitCode === "number" && result.exitCode !== 0) {
    throw new Error(`Daytona command failed: ${result.exitCode}`);
  }
  return result.result ?? "";
}
