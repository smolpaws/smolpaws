/**
 * Container Runner for SmolPaws
 * Spawns agent execution in Apple Container and handles IPC
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import {
  CONTAINER_IMAGE,
  CONTAINER_TIMEOUT,
  CONTAINER_MAX_OUTPUT_SIZE,
  GROUPS_DIR,
} from './config.js';
import { RegisteredGroup } from './types.js';
import {
  buildVolumeMounts,
  type VolumeMount,
} from './agent-runtime/workspace.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---SMOLPAWS_OUTPUT_START---';
const OUTPUT_END_MARKER = '---SMOLPAWS_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  conversationId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  conversationId?: string;
  error?: string;
}


function buildContainerArgs(mounts: VolumeMount[]): string[] {
  const args: string[] = ['run', '-i', '--rm'];

  // Apple Container: --mount for readonly, -v for read-write
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push('--mount', `type=bind,source=${mount.hostPath},target=${mount.containerPath},readonly`);
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
  const containerArgs = buildContainerArgs(mounts);

  logger.debug({
    group: group.name,
    mounts: mounts.map(m => `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`),
    containerArgs: containerArgs.join(' ')
  }, 'Container mount configuration');

  logger.info({
    group: group.name,
    mountCount: mounts.length,
    isMain: input.isMain
  }, 'Spawning container agent');

  const logsDir = path.join(GROUPS_DIR, group.folder, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn('container', containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    container.stdout.on('data', (data) => {
      if (stdoutTruncated) return;
      const chunk = data.toString();
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
      if (chunk.length > remaining) {
        stdout += chunk.slice(0, remaining);
        stdoutTruncated = true;
        logger.warn({ group: group.name, size: stdout.length }, 'Container stdout truncated due to size limit');
      } else {
        stdout += chunk;
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn({ group: group.name, size: stderr.length }, 'Container stderr truncated due to size limit');
      } else {
        stderr += chunk;
      }
    });

    const timeout = setTimeout(() => {
      logger.error({ group: group.name }, 'Container timeout, killing');
      container.kill('SIGKILL');
      resolve({
        status: 'error',
        result: null,
        error: `Container timed out after ${CONTAINER_TIMEOUT}ms`
      });
    }, group.containerConfig?.timeout || CONTAINER_TIMEOUT);

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose = process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``
      ];

      if (isVerbose) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts.map(m => `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`).join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Conversation ID: ${input.conversationId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts.map(m => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`).join('\n'),
          ``
        );

        if (code !== 0) {
          logLines.push(
            `=== Stderr (last 500 chars) ===`,
            stderr.slice(-500),
            ``
          );
        }
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error({
          group: group.name,
          code,
          duration,
          stderr: stderr.slice(-500),
          logFile
        }, 'Container exited with error');

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`
        });
        return;
      }

      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout.slice(startIdx + OUTPUT_START_MARKER.length, endIdx).trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info({
          group: group.name,
          duration,
          status: output.status,
          hasResult: !!output.result
        }, 'Container completed');

        resolve(output);
      } catch (err) {
        logger.error({
          group: group.name,
          stdout: stdout.slice(-500),
          error: err
        }, 'Failed to parse container output');

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error({ group: group.name, error: err }, 'Container spawn error');
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`
      });
    });
  });
}
