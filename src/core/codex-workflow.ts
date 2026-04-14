import path from "node:path";

import { Codex, type CodexOptions, type Thread } from "@openai/codex-sdk";

import { readWorkflowResult, type WorkflowResultManifest } from "./workflow-result.js";
import { resolveAgentSettings } from "./paths.js";
import { readTextFileSync, writeTextFileSync } from "../utils/fs.js";
import { AppError } from "../utils/errors.js";
import type { WikiAgentSandboxMode } from "../types/page.js";

export const CODEX_WORKFLOW_VERSION = "2026-04-07";

export interface CodexWorkflowInput {
  queueItemId: string;
  workspaceRoot: string;
  packageRoot: string;
  promptPath: string;
  promptText: string;
  queueItemPath: string;
  resultPath: string;
  skillArtifactsPath: string;
  model?: string | null;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onThreadStarted?: (threadId: string) => void;
}

export interface CodexWorkflowHandle {
  threadId: string;
  mode: "start" | "resume";
}

export interface CodexWorkflowRunner {
  readonly inlineRetryCapable?: boolean;
  startWorkflow(input: CodexWorkflowInput): Promise<CodexWorkflowHandle>;
  resumeWorkflow(threadId: string, input: CodexWorkflowInput): Promise<CodexWorkflowHandle>;
  collectResult(handle: CodexWorkflowHandle, input: CodexWorkflowInput): Promise<WorkflowResultManifest>;
}

interface CodexSdkWorkflowRunnerOptions {
  sandboxMode?: WikiAgentSandboxMode;
}

function normalizeEnv(input: CodexWorkflowInput): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries({
    ...process.env,
    ...input.env,
    ...(input.env?.WIKI_AGENT_API_KEY && !input.env.OPENAI_API_KEY ? { OPENAI_API_KEY: input.env.WIKI_AGENT_API_KEY } : {}),
  })) {
    if (typeof value === "string") {
      normalized[key] = value;
    }
  }
  normalized.PATH = [input.skillArtifactsPath, normalized.PATH].filter(Boolean).join(path.delimiter);
  return normalized;
}

function createCodexClient(input: CodexWorkflowInput): Codex {
  const env = normalizeEnv(input);
  const baseUrl = input.env?.WIKI_AGENT_BASE_URL?.trim();
  const apiKey = input.env?.WIKI_AGENT_API_KEY?.trim();

  const options: CodexOptions = {
    apiKey: apiKey || undefined,
    env,
  };

  if (baseUrl) {
    // Define a custom model_provider to override any global ~/.codex/config.toml settings.
    // The SDK's `baseUrl` option maps to `openai_base_url` which gets overridden by
    // model_provider; using `config` directly avoids this precedence issue.
    options.config = {
      model_provider: "tiangong-wiki-agent",
      model_providers: {
        "tiangong-wiki-agent": {
          name: "tiangong-wiki-agent",
          base_url: baseUrl,
          wire_api: "responses",
          experimental_bearer_token: apiKey || "",
        },
      },
    };
  }

  return new Codex(options);
}

function persistWorkflowThreadId(queueItemPath: string, threadId: string): void {
  try {
    const raw = readTextFileSync(queueItemPath);
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("queue-item.json must contain an object");
    }

    writeTextFileSync(
      queueItemPath,
      `${JSON.stringify({ ...(parsed as Record<string, unknown>), threadId }, null, 2)}\n`,
    );
  } catch (error) {
    throw new AppError("Failed to persist workflow thread id into queue-item.json", "runtime", {
      queueItemPath,
      threadId,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

async function runThread(thread: Thread, input: CodexWorkflowInput): Promise<string> {
  let activeThreadId = thread.id ?? null;
  let emittedThreadId: string | null = null;
  const emitThreadStarted = (threadId: string) => {
    if (threadId === emittedThreadId) {
      return;
    }
    emittedThreadId = threadId;
    input.onThreadStarted?.(threadId);
  };
  if (activeThreadId) {
    persistWorkflowThreadId(input.queueItemPath, activeThreadId);
    emitThreadStarted(activeThreadId);
  }

  try {
    const streamed = await thread.runStreamed(
      input.promptText,
      input.signal ? { signal: input.signal } : undefined,
    );
    for await (const event of streamed.events) {
      if (event.type === "thread.started") {
        activeThreadId = event.thread_id;
        persistWorkflowThreadId(input.queueItemPath, activeThreadId);
        emitThreadStarted(activeThreadId);
        continue;
      }

      if (event.type === "turn.failed") {
        throw classifyWorkflowRuntimeError("Codex workflow turn failed", event.error.message, activeThreadId);
      }

      if (event.type === "error") {
        throw classifyWorkflowRuntimeError("Codex workflow stream failed", event.message, activeThreadId);
      }
    }
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw classifyWorkflowRuntimeError("Codex workflow turn failed", message, activeThreadId);
  }

  if (!activeThreadId && thread.id) {
    activeThreadId = thread.id;
  }

  if (!activeThreadId) {
    throw new AppError("Codex workflow did not provide a thread id", "runtime");
  }

  persistWorkflowThreadId(input.queueItemPath, activeThreadId);
  return activeThreadId;
}

export class CodexSdkWorkflowRunner implements CodexWorkflowRunner {
  constructor(private readonly options: CodexSdkWorkflowRunnerOptions = {}) {}

  // The SDK can only continue a thread by sending a new input, so queue retries
  // must not automatically resume real workflow threads inline.

  async startWorkflow(input: CodexWorkflowInput): Promise<CodexWorkflowHandle> {
    const codex = createCodexClient(input);
    const thread = codex.startThread({
      model: input.model ?? undefined,
      modelReasoningEffort: "low",
      workingDirectory: input.workspaceRoot,
      skipGitRepoCheck: true,
      sandboxMode: this.options.sandboxMode ?? "danger-full-access",
      networkAccessEnabled: true,
      approvalPolicy: "never",
      webSearchMode: "disabled",
      additionalDirectories: [input.packageRoot, input.skillArtifactsPath],
    });
    const threadId = await runThread(thread, input);
    return { threadId, mode: "start" };
  }

  async resumeWorkflow(threadId: string, input: CodexWorkflowInput): Promise<CodexWorkflowHandle> {
    const codex = createCodexClient(input);
    const thread = codex.resumeThread(threadId, {
      model: input.model ?? undefined,
      modelReasoningEffort: "low",
      workingDirectory: input.workspaceRoot,
      skipGitRepoCheck: true,
      sandboxMode: this.options.sandboxMode ?? "danger-full-access",
      networkAccessEnabled: true,
      approvalPolicy: "never",
      webSearchMode: "disabled",
      additionalDirectories: [input.packageRoot, input.skillArtifactsPath],
    });
    const resumedThreadId = await runThread(thread, input);
    return { threadId: resumedThreadId, mode: "resume" };
  }

  async collectResult(handle: CodexWorkflowHandle, input: CodexWorkflowInput): Promise<WorkflowResultManifest> {
    const manifest = readWorkflowResult(input.resultPath);
    if (manifest.threadId !== handle.threadId) {
      throw new AppError(
        `Workflow result threadId mismatch: expected ${handle.threadId}, got ${manifest.threadId}`,
        "runtime",
      );
    }
    return manifest;
  }
}

export class FakeCodexWorkflowRunner implements CodexWorkflowRunner {
  readonly calls: Array<{ mode: "start" | "resume"; queueItemId: string; threadId: string }> = [];
  private counter = 0;

  constructor(
    private readonly handler: (payload: {
      mode: "start" | "resume";
      queueItemId: string;
      threadId: string;
      input: CodexWorkflowInput;
    }) => WorkflowResultManifest | Promise<WorkflowResultManifest>,
  ) {}

  async startWorkflow(input: CodexWorkflowInput): Promise<CodexWorkflowHandle> {
    const threadId = `fake-thread-${++this.counter}`;
    input.onThreadStarted?.(threadId);
    this.calls.push({ mode: "start", queueItemId: input.queueItemId, threadId });
    const manifest = await this.handler({
      mode: "start",
      queueItemId: input.queueItemId,
      threadId,
      input,
    });
    writeTextFileSync(input.resultPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return { threadId, mode: "start" };
  }

  async resumeWorkflow(threadId: string, input: CodexWorkflowInput): Promise<CodexWorkflowHandle> {
    input.onThreadStarted?.(threadId);
    this.calls.push({ mode: "resume", queueItemId: input.queueItemId, threadId });
    const manifest = await this.handler({
      mode: "resume",
      queueItemId: input.queueItemId,
      threadId,
      input,
    });
    writeTextFileSync(input.resultPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return { threadId, mode: "resume" };
  }

  async collectResult(_handle: CodexWorkflowHandle, input: CodexWorkflowInput): Promise<WorkflowResultManifest> {
    return readWorkflowResult(input.resultPath);
  }
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function createSkipOnlyTestWorkflowRunner(options: { delayMs?: number; mode: string }): CodexWorkflowRunner {
  const delayMs = Math.max(0, options.delayMs ?? 0);

  return new FakeCodexWorkflowRunner(async ({ threadId }) => {
    await delay(delayMs);
    return {
      status: "skipped",
      decision: "skip",
      reason: `Skipped by WIKI_TEST_FAKE_WORKFLOW_MODE=${options.mode}.`,
      threadId,
      skillsUsed: ["tiangong-wiki-skill"],
      createdPageIds: [],
      updatedPageIds: [],
      appliedTypeNames: [],
      proposedTypes: [],
      actions: [],
      lint: [],
    };
  });
}

export function createDefaultWorkflowRunner(env: NodeJS.ProcessEnv = process.env): CodexWorkflowRunner {
  if (env.WIKI_TEST_FAKE_WORKFLOW_MODE === "skip") {
    return createSkipOnlyTestWorkflowRunner({ mode: "skip" });
  }

  if (env.WIKI_TEST_FAKE_WORKFLOW_MODE === "delay-skip") {
    const delayMs = Number.parseInt(env.WIKI_TEST_FAKE_WORKFLOW_DELAY_MS ?? "0", 10) || 0;
    return createSkipOnlyTestWorkflowRunner({ delayMs, mode: "delay-skip" });
  }

  return new CodexSdkWorkflowRunner({
    sandboxMode: resolveAgentSettings(env).sandboxMode,
  });
}

function isSandboxStartupFailure(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("bwrap") ||
    normalized.includes("bubblewrap") ||
    normalized.includes("uid map") ||
    normalized.includes("uid_map") ||
    normalized.includes("gid map") ||
    normalized.includes("gid_map") ||
    normalized.includes("unshare") ||
    normalized.includes("operation not permitted")
  );
}

function classifyWorkflowRuntimeError(baseMessage: string, cause: string, threadId: string | null): AppError {
  if (isSandboxStartupFailure(cause)) {
    return new AppError("Codex workflow sandbox failed to initialize", "runtime", {
      cause,
      threadId,
      phase: "sandbox",
    });
  }

  return new AppError(baseMessage, "runtime", {
    cause,
    threadId,
  });
}
