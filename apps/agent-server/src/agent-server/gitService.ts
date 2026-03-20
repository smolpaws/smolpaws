import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { RunnerEnv } from "../runner/workspacePolicy.js";
import {
  findNearestExistingPath,
  isAllowedWorkspacePath,
  isAuthorized,
  resolveRequestedAbsolutePath,
} from "../runner/workspacePolicy.js";
import type { ErrorResponse, GitChange, GitDiff } from "./models.js";

async function runCapturedCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: typeof code === "number" ? code : 1,
      });
    });
  });
}

async function resolveGitRepositoryRoot(targetPath: string): Promise<string> {
  const stats = await fs.stat(targetPath);
  const cwd = stats.isDirectory() ? targetPath : path.dirname(targetPath);
  const result = await runCapturedCommand(
    "git",
    ["rev-parse", "--show-toplevel"],
    cwd,
  );
  if (result.exitCode !== 0) {
    throw new Error("git_repository_not_found");
  }
  return result.stdout.trim();
}

function mapGitStatus(status: string): GitChange["status"] {
  switch (status) {
    case "M":
    case "U":
      return "UPDATED";
    case "A":
    case "??":
      return "ADDED";
    case "D":
      return "DELETED";
    default:
      throw new Error(`unsupported_git_status:${status}`);
  }
}

export async function getGitChanges(targetPath: string): Promise<GitChange[]> {
  const repoRoot = await resolveGitRepositoryRoot(targetPath);
  const absoluteTargetPath = path.resolve(targetPath);
  const relativePath = path.relative(repoRoot, absoluteTargetPath);
  const pathArgs = relativePath && relativePath !== "." ? ["--", relativePath] : [];
  const diffResult = await runCapturedCommand(
    "git",
    ["--no-pager", "diff", "--name-status", "HEAD", ...pathArgs],
    repoRoot,
  );
  if (diffResult.exitCode !== 0) {
    throw new Error(diffResult.stderr.trim() || "git_changes_failed");
  }

  const changes: GitChange[] = [];
  for (const line of diffResult.stdout.split("\n")) {
    const normalizedLine = line.replace(/\r$/, "");
    if (!normalizedLine.trim()) {
      continue;
    }
    const parts = normalizedLine.split("\t");
    const status = parts[0]?.trim() ?? "";
    if ((status.startsWith("R") || status.startsWith("C")) && parts.length >= 3) {
      const oldPath = parts[1] ?? "";
      const newPath = parts[2] ?? "";
      if (status.startsWith("R")) {
        changes.push({ status: "DELETED", path: oldPath });
      }
      changes.push({ status: "ADDED", path: newPath });
      continue;
    }
    const filePath = parts[1] ?? "";
    changes.push({ status: mapGitStatus(status), path: filePath });
  }

  const untrackedResult = await runCapturedCommand(
    "git",
    ["--no-pager", "ls-files", "--others", "--exclude-standard", ...pathArgs],
    repoRoot,
  );
  if (untrackedResult.exitCode === 0) {
    for (const line of untrackedResult.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      changes.push({ status: "ADDED", path: trimmed });
    }
  }

  return changes;
}

export async function getGitDiff(targetPath: string): Promise<GitDiff> {
  const absolutePath = path.resolve(targetPath);
  const repoRoot = await resolveGitRepositoryRoot(absolutePath);
  const relativePath = path.relative(repoRoot, absolutePath);
  const originalResult = await runCapturedCommand(
    "git",
    ["show", `HEAD:${relativePath}`],
    repoRoot,
  );
  const modified = await fs.readFile(absolutePath, "utf8").catch(() => "");
  return {
    modified: modified ? modified.split(/\r?\n/).join("\n") : "",
    original:
      originalResult.exitCode === 0
        ? originalResult.stdout.split(/\r?\n/).join("\n")
        : "",
  };
}

async function resolveReadableGitPath(
  rawPath: string,
  env: RunnerEnv,
): Promise<string> {
  const absolutePath = resolveRequestedAbsolutePath(rawPath);
  const exists = await fs.stat(absolutePath).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return false;
      }
      throw error;
    },
  );
  const authorizationPath = exists
    ? absolutePath
    : await findNearestExistingPath(absolutePath);
  if (!(await isAllowedWorkspacePath(authorizationPath, env, "read"))) {
    throw new Error("git_path_not_allowed");
  }
  if (!exists) {
    throw new Error("git_path_not_found");
  }
  return absolutePath;
}

function buildGitRouteErrorResponse(
  reply: FastifyReply,
  message: string,
): ErrorResponse {
  if (message === "git_path_not_allowed") {
    reply.status(403);
    return { error: "Path is outside allowed workspace roots" };
  }
  if (message === "git_path_not_found") {
    reply.status(400);
    return { error: "Path does not exist" };
  }
  reply.status(400);
  return { error: message };
}

export async function handleGitRoute<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  env: RunnerEnv,
  rawPath: string,
  operation: (absolutePath: string) => Promise<T>,
): Promise<T | ErrorResponse> {
  const auth = isAuthorized(request, env);
  if (!auth.allowed) {
    reply.status(401);
    return { error: auth.reason ?? "Unauthorized" };
  }

  try {
    const absolutePath = await resolveReadableGitPath(rawPath, env);
    return await operation(absolutePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return buildGitRouteErrorResponse(reply, message);
  }
}
