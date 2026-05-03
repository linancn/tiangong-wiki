import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_WIKI_AGENT_MODEL, resolveAgentSettings } from "../../src/core/paths.js";

describe("agent settings", () => {
  it("defaults the agent model to gpt-5.5", () => {
    const settings = resolveAgentSettings({
      WIKI_AGENT_ENABLED: "true",
      WIKI_AGENT_API_KEY: "test-key",
    });

    expect(settings.model).toBe(DEFAULT_WIKI_AGENT_MODEL);
    expect(settings.missing).toEqual([]);
  });

  it("requires an API key only in api-key auth mode", () => {
    expect(() =>
      resolveAgentSettings(
        {
          WIKI_AGENT_ENABLED: "true",
          WIKI_AGENT_AUTH_MODE: "api-key",
        },
        { strict: true },
      ),
    ).toThrow("WIKI_AGENT_ENABLED=true but missing required settings: WIKI_AGENT_API_KEY");

    const codexLogin = resolveAgentSettings(
      {
        WIKI_AGENT_ENABLED: "true",
        WIKI_AGENT_AUTH_MODE: "codex-login",
      },
      { strict: true },
    );

    expect(codexLogin.apiKey).toBeNull();
    expect(codexLogin.codexHome).toBe(path.join(os.homedir(), ".codex-tiangong-wiki"));
    expect(codexLogin.missing).toEqual([]);
  });
});
