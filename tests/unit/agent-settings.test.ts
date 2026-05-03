import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseEnvFile } from "../../src/core/cli-env.js";
import { DEFAULT_WIKI_AGENT_MODEL, resolveAgentSettings } from "../../src/core/paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

  it("keeps the packaged example free of machine-specific Codex home paths", () => {
    const examplePath = path.resolve(__dirname, "../../assets/config.example.env");
    const example = readFileSync(examplePath, "utf8");
    const parsed = parseEnvFile(example);
    const settings = resolveAgentSettings(parsed);

    expect(example).not.toContain("/Users/davidli");
    expect(example).toContain("# WIKI_AGENT_AUTH_MODE=api-key");
    expect(example).toContain("# WIKI_AGENT_API_KEY=sk-...");
    expect(parsed.WIKI_AGENT_CODEX_HOME).toBeUndefined();
    expect(parsed.WIKI_AGENT_API_KEY).toBeUndefined();
    expect(settings.authMode).toBe("codex-login");
    expect(settings.codexHome).toBe(path.join(os.homedir(), ".codex-tiangong-wiki"));
  });
});
