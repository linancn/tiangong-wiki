import { describe, expect, it } from "vitest";

import { createWorkspace } from "../helpers.js";
import { parseWikiAgentBackend, resolveRuntimePaths } from "../../src/core/paths.js";

describe("queue backend toggle", () => {
  it("defaults to the codex-workflow backend", () => {
    const workspace = createWorkspace();
    const paths = resolveRuntimePaths(workspace.env);
    expect(paths.agentBackend).toBe("codex-workflow");
  });

  it("rejects unsupported backend values early", () => {
    expect(() => parseWikiAgentBackend("legacy")).toThrowError(
      'WIKI_AGENT_BACKEND must be "codex-workflow", got legacy',
    );
  });
});
