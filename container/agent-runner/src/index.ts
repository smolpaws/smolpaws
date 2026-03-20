/**
 * SmolPaws Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 * Uses OpenHands Agent SDK (agent-sdk-ts) for conversation management
 */

import { Conversation } from '@smolpaws/agent-sdk';
import type { Event, MessageEvent } from '@smolpaws/agent-sdk';
import { createIpcTools } from './ipc-tools.js';

interface ContainerInput {
  prompt: string;
  conversationId?: string;
  scopeId?: string;
  groupFolder?: string;
  chatJid: string;
  isControlScope?: boolean;
  isMain?: boolean;
  isScheduledTask?: boolean;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  conversationId?: string;
  error?: string;
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---SMOLPAWS_OUTPUT_START---';
const OUTPUT_END_MARKER = '---SMOLPAWS_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function isMessageEvent(event: Event): event is MessageEvent {
  return event.kind === 'MessageEvent';
}

function resolveScopeId(input: ContainerInput): string {
  const scopeId = input.scopeId ?? input.groupFolder;
  if (!scopeId) {
    throw new Error('Missing scopeId');
  }
  return scopeId;
}

function resolveIsControlScope(input: ContainerInput): boolean {
  return input.isControlScope ?? input.isMain ?? false;
}

async function main(): Promise<void> {
  let input: ContainerInput;

  try {
    const stdinData = await readStdin();
    input = JSON.parse(stdinData);
    log(`Received input for scope: ${resolveScopeId(input)}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  const scopeId = resolveScopeId(input);
  const isControlScope = resolveIsControlScope(input);

  const ipcTools = createIpcTools({
    chatJid: input.chatJid,
    scopeId,
    isControlScope
  });

  let result: string | null = null;
  let conversationId: string | undefined;

  // Add context for scheduled tasks
  let prompt = input.prompt;
  if (input.isScheduledTask) {
    prompt = `[SCHEDULED TASK - You are running automatically, not in response to a user message. Use send_message if needed to communicate with the user.]\n\n${input.prompt}`;
  }

  try {
    log('Starting agent...');

    const conversation = Conversation({
      settings: {
        llm: {
          provider: 'anthropic',
          model: process.env.MODEL || 'claude-sonnet-4-20250514',
        },
        agent: { enableSecurityAnalyzer: false },
        conversation: { maxIterations: 100 },
        confirmation: { policy: 'never' },
        secrets: {},
      },
      tools: ipcTools,
      includeDefaultTools: ['terminal', 'file_editor'],
      workspaceRoot: '/workspace/group',
      persistenceDir: '/workspace/conversations',
      conversationId: input.conversationId,
    });

    // Capture assistant messages for the result
    const assistantMessages: string[] = [];

    conversation.on('event', (event: Event) => {
      if (isMessageEvent(event) && event.source === 'agent') {
        const msg = event.llm_message;
        if (msg && msg.content) {
          const textParts = Array.isArray(msg.content)
            ? msg.content
                .filter((c: { type: string }) => c.type === 'text')
                .map((c: { type: string; text?: string }) => c.text || '')
            : [String(msg.content)];
          const text = textParts.join('');
          if (text) assistantMessages.push(text);
        }
      }
    });

    conversation.on('error', (err: unknown) => {
      log(`Conversation error: ${err instanceof Error ? err.message : String(err)}`);
    });

    // Start or restore conversation
    if (input.conversationId) {
      conversation.restoreConversation(input.conversationId);
      log(`Restored conversation: ${input.conversationId}`);
    } else {
      const newId = await conversation.startNewConversation();
      log(`New conversation: ${newId}`);
    }

    conversationId = conversation.getConversationId();

    // Send the user message and wait for agent to complete
    await conversation.sendUserMessage(prompt);

    // Extract the last assistant message as the result
    result = assistantMessages.length > 0
      ? assistantMessages[assistantMessages.length - 1]
      : null;

    log('Agent completed successfully');
    conversation.disconnect();

    writeOutput({
      status: 'success',
      result,
      conversationId
    });

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      conversationId,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
