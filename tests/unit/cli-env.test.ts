import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyCliEnvironment,
  DEFAULT_WIKI_ENV_FILE,
  parseEnvFile,
  serializeEnvEntries,
} from "../../src/core/cli-env.js";
import { resolveGlobalConfigPath } from "../../src/core/global-config.js";

function createEnvFixture(contents: string): { root: string; cwd: string; envFilePath: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "wiki-cli-env-"));
  const cwd = path.join(root, "workspace", "nested");
  const envFilePath = path.join(root, DEFAULT_WIKI_ENV_FILE);

  mkdirSync(cwd, { recursive: true });
  writeFileSync(envFilePath, contents, "utf8");

  return { root, cwd, envFilePath };
}

function writeGlobalDefaultConfig(root: string, defaultEnvFile: string): string {
  const env: NodeJS.ProcessEnv = { HOME: root };
  const configPath = resolveGlobalConfigPath(env);
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify({ schemaVersion: 1, defaultEnvFile }, null, 2)}\n`,
    "utf8",
  );
  return configPath;
}

describe("cli env loading", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("auto-discovers the nearest .wiki.env when no runtime paths are preset", () => {
    const fixture = createEnvFixture(
      [
        "WIKI_PATH=/tmp/discovered/pages",
        "VAULT_PATH=/tmp/discovered/vault",
        "WIKI_CONFIG_PATH=/tmp/discovered/wiki.config.json",
        "",
      ].join("\n"),
    );
    tempDirs.push(fixture.root);

    const env: NodeJS.ProcessEnv = {};
    const info = applyCliEnvironment(env, fixture.cwd);

    expect(info.loadedPath).toBe(fixture.envFilePath);
    expect(info.autoDiscovered).toBe(true);
    expect(info.source).toBe("nearest-env-file");
    expect(info.loadedKeys).toEqual(["WIKI_PATH", "VAULT_PATH", "WIKI_CONFIG_PATH"]);
    expect(env.WIKI_PATH).toBe("/tmp/discovered/pages");
    expect(env.WIKI_ENV_FILE).toBe(fixture.envFilePath);
  });

  it("skips auto-discovery when core runtime paths are already provided", () => {
    const fixture = createEnvFixture(
      [
        "WIKI_CONFIG_PATH=/tmp/discovered/wiki.config.json",
        "WIKI_DB_PATH=/tmp/discovered/index.db",
        "",
      ].join("\n"),
    );
    tempDirs.push(fixture.root);

    const env: NodeJS.ProcessEnv = {
      WIKI_PATH: "/tmp/explicit/pages",
      VAULT_PATH: "/tmp/explicit/vault",
    };
    const info = applyCliEnvironment(env, fixture.cwd);

    expect(info.loadedPath).toBeNull();
    expect(info.autoDiscovered).toBe(false);
    expect(info.source).toBe("process-env");
    expect(info.loadedKeys).toEqual([]);
    expect(env.WIKI_CONFIG_PATH).toBeUndefined();
    expect(env.WIKI_DB_PATH).toBeUndefined();
    expect(env.WIKI_ENV_FILE).toBeUndefined();
  });

  it("still loads an explicitly requested env file when runtime paths are preset", () => {
    const fixture = createEnvFixture(
      [
        "WIKI_DB_PATH=/tmp/discovered/index.db",
        "WIKI_TEMPLATES_PATH=/tmp/discovered/templates",
        "",
      ].join("\n"),
    );
    tempDirs.push(fixture.root);

    const env: NodeJS.ProcessEnv = {
      WIKI_PATH: "/tmp/explicit/pages",
      WIKI_ENV_FILE: fixture.envFilePath,
    };
    const info = applyCliEnvironment(env, fixture.cwd);

    expect(info.requestedPath).toBe(fixture.envFilePath);
    expect(info.loadedPath).toBe(fixture.envFilePath);
    expect(info.autoDiscovered).toBe(false);
    expect(info.source).toBe("explicit-env-file");
    expect(info.loadedKeys).toEqual(["WIKI_DB_PATH", "WIKI_TEMPLATES_PATH"]);
    expect(env.WIKI_PATH).toBe("/tmp/explicit/pages");
    expect(env.WIKI_DB_PATH).toBe("/tmp/discovered/index.db");
  });

  it("falls back to the global default env file outside any workspace", () => {
    const fixture = createEnvFixture(
      [
        "WIKI_PATH=/tmp/default/pages",
        "VAULT_PATH=/tmp/default/vault",
        "",
      ].join("\n"),
    );
    tempDirs.push(fixture.root);
    const outsideCwd = mkdtempSync(path.join(os.tmpdir(), "wiki-cli-outside-"));
    tempDirs.push(outsideCwd);
    const globalConfigPath = writeGlobalDefaultConfig(fixture.root, fixture.envFilePath);

    const env: NodeJS.ProcessEnv = { HOME: fixture.root };
    const info = applyCliEnvironment(env, outsideCwd);

    expect(info.loadedPath).toBe(fixture.envFilePath);
    expect(info.source).toBe("global-default-env-file");
    expect(info.globalConfigPath).toBe(globalConfigPath);
    expect(info.defaultPath).toBe(fixture.envFilePath);
    expect(env.WIKI_PATH).toBe("/tmp/default/pages");
  });

  it("prefers the local workspace env file over the global default config", () => {
    const fixture = createEnvFixture(
      [
        "WIKI_PATH=/tmp/local/pages",
        "VAULT_PATH=/tmp/local/vault",
        "",
      ].join("\n"),
    );
    tempDirs.push(fixture.root);

    const otherRoot = mkdtempSync(path.join(os.tmpdir(), "wiki-cli-other-"));
    tempDirs.push(otherRoot);
    const otherEnvPath = path.join(otherRoot, DEFAULT_WIKI_ENV_FILE);
    writeFileSync(otherEnvPath, ["WIKI_PATH=/tmp/global/pages", "VAULT_PATH=/tmp/global/vault", ""].join("\n"), "utf8");
    writeGlobalDefaultConfig(fixture.root, otherEnvPath);

    const env: NodeJS.ProcessEnv = { HOME: fixture.root };
    const info = applyCliEnvironment(env, fixture.cwd);

    expect(info.loadedPath).toBe(fixture.envFilePath);
    expect(info.source).toBe("nearest-env-file");
    expect(env.WIKI_PATH).toBe("/tmp/local/pages");
  });

  it("records when the global default config points to a missing env file", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wiki-cli-missing-default-"));
    tempDirs.push(root);
    const outsideCwd = mkdtempSync(path.join(os.tmpdir(), "wiki-cli-outside-"));
    tempDirs.push(outsideCwd);
    const missingEnvPath = path.join(root, "missing", DEFAULT_WIKI_ENV_FILE);
    const globalConfigPath = writeGlobalDefaultConfig(root, missingEnvPath);

    const env: NodeJS.ProcessEnv = { HOME: root };
    const info = applyCliEnvironment(env, outsideCwd);

    expect(info.loadedPath).toBeNull();
    expect(info.source).toBe("global-default-env-file");
    expect(info.missingDefaultPath).toBe(true);
    expect(info.requestedPath).toBe(missingEnvPath);
    expect(info.globalConfigPath).toBe(globalConfigPath);
  });

  it("round-trips quoted Windows paths without treating escaped backslash-n as a newline", () => {
    const windowsPath = String.raw`C:\new\wiki pages\pages`;
    const serialized = serializeEnvEntries([["WIKI_PATH", windowsPath]]);

    expect(serialized).toContain("WIKI_PATH=");
    expect(parseEnvFile(serialized).WIKI_PATH).toBe(windowsPath);
  });
});
