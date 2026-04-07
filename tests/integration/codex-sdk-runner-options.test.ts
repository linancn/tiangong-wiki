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

  it("enables network access and persists runtime thread ids for start and resume", async () => {
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
    expect(startThread).toHaveBeenCalledWith(
      expect.objectContaining({
        modelReasoningEffort: "low",
        sandboxMode: "workspace-write",
        networkAccessEnabled: true,
        approvalPolicy: "never",
        webSearchMode: "disabled",
      }),
    );
    expect(resumeThread).toHaveBeenCalledWith(
      "persisted-thread",
      expect.objectContaining({
        modelReasoningEffort: "low",
        sandboxMode: "workspace-write",
        networkAccessEnabled: true,
        approvalPolicy: "never",
        webSearchMode: "disabled",
      }),
    );
    const startedRun = startThread.mock.results[0]?.value.runStreamed as ReturnType<typeof vi.fn>;
    const resumedRun = resumeThread.mock.results[0]?.value.runStreamed as ReturnType<typeof vi.fn>;
    expect(startedRun).toHaveBeenCalledWith("Process the queue item.");
    expect(resumedRun).toHaveBeenCalledWith("Process the queue item.");
  });
});
