import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const startThread = vi.fn();
const resumeThread = vi.fn();
const CodexConstructor = vi.fn();

const tempDirs: string[] = [];

class CodexMock {
  constructor(options: unknown) {
    CodexConstructor(options);
  }

  startThread = startThread;
  resumeThread = resumeThread;
}

vi.mock("@openai/codex-sdk", () => ({
  Codex: CodexMock,
}));

function eventStream(events: unknown[]) {
  return (async function* stream() {
    for (const event of events) {
      yield event;
    }
  })();
}

describe("CodexSdkWorkflowRunner", () => {
  afterEach(() => {
    vi.clearAllMocks();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds a hidden-window default to Codex SDK child process spawns", async () => {
    const calls: unknown[][] = [];
    const fakeSpawn = ((...args: unknown[]) => {
      calls.push(args);
      return {} as never;
    }) as typeof import("node:child_process").spawn;

    const { createHiddenWindowsSpawn } = await import("../../src/core/codex-workflow.js");
    const spawn = createHiddenWindowsSpawn(fakeSpawn);

    spawn("codex.exe", ["exec"], { env: { CODEX_HOME: "C:\\codex-home" } });
    spawn("codex.exe", ["exec"], { windowsHide: false });
    spawn("codex.exe", { cwd: "C:\\workspace" });
    spawn("codex.exe");

    expect(calls[0]?.[2]).toEqual({ env: { CODEX_HOME: "C:\\codex-home" }, windowsHide: true });
    expect(calls[1]?.[2]).toEqual({ windowsHide: false });
    expect(calls[2]?.[1]).toEqual({ cwd: "C:\\workspace", windowsHide: true });
    expect(calls[3]?.[1]).toEqual({ windowsHide: true });
  });

  it("defaults to danger-full-access, supports sandbox override, and persists runtime thread ids for start and resume", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wiki-codex-sdk-runner-"));
    tempDirs.push(root);
    const promptPath = path.join(root, "prompt.md");
    const queueItemPath = path.join(root, "queue-item.json");
    const resultPath = path.join(root, "result.json");

    writeFileSync(promptPath, "Process the queue item.\n", "utf8");
    writeFileSync(queueItemPath, `${JSON.stringify({ fileId: "imports/spec.pdf", threadId: null }, null, 2)}\n`, "utf8");
    writeFileSync(resultPath, "", "utf8");

    startThread.mockReturnValue({
      id: null,
      runStreamed: vi.fn().mockResolvedValue({
        events: eventStream([
          { type: "thread.started", thread_id: "thread-start" },
          { type: "turn.started" },
          {
            type: "turn.completed",
            usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
          },
        ]),
      }),
    });
    resumeThread.mockReturnValue({
      id: "persisted-thread",
      runStreamed: vi.fn().mockResolvedValue({
        events: eventStream([
          { type: "turn.started" },
          {
            type: "turn.completed",
            usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
          },
        ]),
      }),
    });

    const { CodexSdkWorkflowRunner } = await import("../../src/core/codex-workflow.js");
    const runner = new CodexSdkWorkflowRunner();
    expect(Object.prototype.hasOwnProperty.call(runner, "inlineRetryCapable")).toBe(false);
    const input = {
      queueItemId: "imports/spec.pdf",
      workspaceRoot: root,
      packageRoot: path.resolve(root, ".."),
      promptPath,
      promptText: "Process the queue item.",
      queueItemPath,
      resultPath,
      skillArtifactsPath: path.join(root, "skill-artifacts"),
      model: "gpt-5.4",
      env: {
        WIKI_AGENT_API_KEY: "agent-key",
      },
    };

    const started = await runner.startWorkflow(input);
    expect(started.threadId).toBe("thread-start");
    expect(JSON.parse(readFileSync(queueItemPath, "utf8"))).toEqual(
      expect.objectContaining({
        fileId: "imports/spec.pdf",
        threadId: "thread-start",
      }),
    );

    const resumed = await runner.resumeWorkflow("persisted-thread", input);
    expect(resumed.threadId).toBe("persisted-thread");
    expect(JSON.parse(readFileSync(queueItemPath, "utf8"))).toEqual(
      expect.objectContaining({
        fileId: "imports/spec.pdf",
        threadId: "persisted-thread",
      }),
    );

    expect(CodexConstructor).toHaveBeenCalledTimes(2);
    const startOptions = startThread.mock.calls[0]?.[0] as Record<string, unknown>;
    const resumeOptions = resumeThread.mock.calls[0]?.[1] as Record<string, unknown>;
    const startClientOptions = CodexConstructor.mock.calls[0]?.[0] as { env?: Record<string, string> };
    expect(startThread).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: root,
        modelReasoningEffort: "low",
        sandboxMode: "danger-full-access",
        networkAccessEnabled: true,
        approvalPolicy: "never",
        webSearchMode: "disabled",
      }),
    );
    expect(resumeThread).toHaveBeenCalledWith(
      "persisted-thread",
      expect.objectContaining({
        workingDirectory: root,
        modelReasoningEffort: "low",
        sandboxMode: "danger-full-access",
        networkAccessEnabled: true,
        approvalPolicy: "never",
        webSearchMode: "disabled",
      }),
    );
    expect(startOptions.additionalDirectories).toEqual([path.resolve(root, ".."), path.join(root, "skill-artifacts")]);
    expect(resumeOptions.additionalDirectories).toEqual([path.resolve(root, ".."), path.join(root, "skill-artifacts")]);
    expect(startClientOptions.env?.PATH?.startsWith(`${path.join(root, "skill-artifacts")}${path.delimiter}`)).toBe(true);
    expect(startClientOptions.env?.WIKI_CLI_WRAPPER).toBeUndefined();
    const startedRun = startThread.mock.results[0]?.value.runStreamed as ReturnType<typeof vi.fn>;
    const resumedRun = resumeThread.mock.results[0]?.value.runStreamed as ReturnType<typeof vi.fn>;
    expect(startedRun).toHaveBeenCalledWith("Process the queue item.", undefined);
    expect(resumedRun).toHaveBeenCalledWith("Process the queue item.", undefined);
  });

  it("uses an isolated CODEX_HOME and no API key when configured for Codex login auth", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wiki-codex-sdk-login-"));
    tempDirs.push(root);
    const promptPath = path.join(root, "prompt.md");
    const queueItemPath = path.join(root, "queue-item.json");
    const resultPath = path.join(root, "result.json");
    const codexHome = path.join(root, ".codex-tiangong-wiki");

    writeFileSync(promptPath, "Process the queue item.\n", "utf8");
    writeFileSync(queueItemPath, `${JSON.stringify({ fileId: "imports/spec.pdf", threadId: null }, null, 2)}\n`, "utf8");
    writeFileSync(resultPath, "", "utf8");

    startThread.mockReturnValue({
      id: null,
      runStreamed: vi.fn().mockResolvedValue({
        events: eventStream([
          { type: "thread.started", thread_id: "thread-login" },
          { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
        ]),
      }),
    });

    const { CodexSdkWorkflowRunner } = await import("../../src/core/codex-workflow.js");
    const runner = new CodexSdkWorkflowRunner();
    await runner.startWorkflow({
      queueItemId: "imports/spec.pdf",
      workspaceRoot: root,
      packageRoot: path.resolve(root, ".."),
      promptPath,
      promptText: "Process the queue item.",
      queueItemPath,
      resultPath,
      skillArtifactsPath: path.join(root, "skill-artifacts"),
      model: "gpt-5.5",
      env: {
        WIKI_AGENT_AUTH_MODE: "codex-login",
        WIKI_AGENT_CODEX_HOME: codexHome,
        OPENAI_API_KEY: "ambient-openai-key",
        CODEX_API_KEY: "ambient-codex-key",
      },
    });

    const clientOptions = CodexConstructor.mock.calls[0]?.[0] as {
      apiKey?: string;
      env?: Record<string, string>;
      config?: unknown;
    };
    expect(clientOptions.apiKey).toBeUndefined();
    expect(clientOptions.config).toBeUndefined();
    expect(clientOptions.env?.CODEX_HOME).toBe(codexHome);
    expect(clientOptions.env?.OPENAI_API_KEY).toBeUndefined();
    expect(clientOptions.env?.CODEX_API_KEY).toBeUndefined();
  });

  it("classifies sandbox startup failures with a dedicated error", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wiki-codex-sdk-sandbox-"));
    tempDirs.push(root);
    const promptPath = path.join(root, "prompt.md");
    const queueItemPath = path.join(root, "queue-item.json");
    const resultPath = path.join(root, "result.json");

    writeFileSync(promptPath, "Process the queue item.\n", "utf8");
    writeFileSync(queueItemPath, `${JSON.stringify({ fileId: "imports/spec.pdf", threadId: null }, null, 2)}\n`, "utf8");
    writeFileSync(resultPath, "", "utf8");

    startThread.mockReturnValue({
      id: null,
      runStreamed: vi.fn().mockRejectedValue(new Error("bwrap: setting up uid map: Permission denied")),
    });

    const { CodexSdkWorkflowRunner } = await import("../../src/core/codex-workflow.js");
    const runner = new CodexSdkWorkflowRunner({ sandboxMode: "workspace-write" });
    const input = {
      queueItemId: "imports/spec.pdf",
      workspaceRoot: root,
      packageRoot: path.resolve(root, ".."),
      promptPath,
      promptText: "Process the queue item.",
      queueItemPath,
      resultPath,
      skillArtifactsPath: path.join(root, "skill-artifacts"),
      model: "gpt-5.4",
      env: {
        WIKI_AGENT_API_KEY: "agent-key",
      },
    };

    await expect(runner.startWorkflow(input)).rejects.toThrowError("Codex workflow sandbox failed to initialize");
  });
});
