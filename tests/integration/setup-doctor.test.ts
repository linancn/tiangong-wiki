import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cleanupWorkspace, createWorkspace, readFile, readJson, runCli, startSynologyServer } from "../helpers.js";

function stripWikiEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (
      key === "WIKI_ENV_FILE" ||
      key.startsWith("WIKI_") ||
      key.startsWith("VAULT_") ||
      key.startsWith("SYNOLOGY_") ||
      key.startsWith("EMBEDDING_") ||
      key.startsWith("OPENROUTER_")
    ) {
      delete next[key];
    }
  }
  return next;
}

function createFakeSkillsInstaller(workspaceRoot: string, mode: "success" | "failure" = "success"): string {
  const binDir = path.join(workspaceRoot, "fake-bin");
  mkdirSync(binDir, { recursive: true });
  const installerPath = path.join(binDir, "npx");
  writeFileSync(
    installerPath,
    mode === "success"
      ? [
          "#!/bin/sh",
          "skill_name=\"\"",
          "while [ \"$#\" -gt 0 ]; do",
          "  if [ \"$1\" = \"--skill\" ]; then",
          "    shift",
          "    skill_name=\"$1\"",
          "  fi",
          "  shift",
          "done",
          "mkdir -p \"$PWD/.agents/skills/$skill_name\"",
          "printf '%s\\n' '---' \"name: $skill_name\" 'description: fake skill' '---' > \"$PWD/.agents/skills/$skill_name/SKILL.md\"",
          "",
        ].join("\n")
      : ['#!/bin/sh', 'echo "fake installer failure" >&2', "exit 7", ""].join("\n"),
    "utf8",
  );
  chmodSync(installerPath, 0o755);
  return binDir;
}

describe("setup and doctor integration", () => {
  const workspaces: ReturnType<typeof createWorkspace>[] = [];
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()!.close();
    }
    while (workspaces.length > 0) {
      cleanupWorkspace(workspaces.pop()!);
    }
  });

  it("runs the interactive setup wizard, writes .wiki.env, and lets doctor/init reuse it automatically", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);

    const env = {
      ...stripWikiEnv(workspace.env),
      PATH: [createFakeSkillsInstaller(workspace.root), process.env.PATH].filter(Boolean).join(path.delimiter),
    };
    const answers = [
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "n",
      "n",
      "y",
      "n",
      "n",
      "n",
      "y",
      "",
    ].join("\n");

    const setup = runCli(["setup"], env, {
      cwd: workspace.root,
      input: answers,
    });
    expect(setup.status).toBe(0);
    expect(setup.stdout).toContain("tiangong-wiki setup complete");

    const envFilePath = `${workspace.root}/.wiki.env`;
    const envFile = readFile(envFilePath);
    expect(envFile).toContain("WIKI_PATH=");
    expect(envFile).toContain("VAULT_PATH=");
    expect(envFile).toContain("WIKI_AGENT_ENABLED=false");
    expect(envFile).toContain("WIKI_PARSER_SKILLS=pdf");
    expect(readFile(path.join(workspace.root, ".agents", "skills", "tiangong-wiki-skill", "SKILL.md"))).toContain(
      "name: tiangong-wiki-skill",
    );
    expect(readFile(path.join(workspace.root, ".agents", "skills", "pdf", "SKILL.md"))).toContain("name: pdf");

    const doctor = runCli(["doctor", "--format", "json"], env, { cwd: workspace.root });
    expect(doctor.status).toBe(0);
    const report = readJson<{
      ok: boolean;
      envFile: { loadedPath: string | null };
      skills: { requestedParserSkills: string[]; missingSkills: string[] };
      checks: Array<{ id: string; severity: string }>;
    }>(doctor.stdout);
    expect(report.ok).toBe(true);
    expect(report.envFile.loadedPath).toBe(realpathSync(envFilePath));
    expect(report.skills.requestedParserSkills).toEqual(["pdf"]);
    expect(report.skills.missingSkills).toEqual([]);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "env-file", severity: "ok" }),
        expect.objectContaining({ id: "config", severity: "ok" }),
        expect.objectContaining({ id: "tiangong-wiki-skill", severity: "ok" }),
        expect.objectContaining({ id: "parser-skills", severity: "ok" }),
      ]),
    );

    const init = runCli(["init"], env, { cwd: workspace.root });
    expect(init.status).toBe(0);
    expect(init.stdout).toContain('"initialized": true');
  });

  it("configures Synology vault settings during setup and lets doctor probe the NAS connection", async () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);

    const server = await startSynologyServer(workspace.root, {
      files: {
        "/vault/briefs/spec.pdf": {
          size: 11,
          mtime: 1_700_000_100,
          content: "spec-bytes",
        },
      },
    });
    servers.push(server);

    const env = stripWikiEnv(workspace.env);
    const answers = [
      "",
      "synology",
      "",
      "",
      "",
      "",
      "",
      server.baseUrl,
      "tester",
      "secret",
      "/vault",
      "",
      "",
      "",
      "",
      "n",
      "n",
      "n",
      "n",
      "n",
      "n",
      "",
    ].join("\n");

    const setup = runCli(["setup"], env, {
      cwd: workspace.root,
      input: answers,
    });
    expect(setup.status).toBe(0);
    expect(setup.stdout).toContain("tiangong-wiki setup complete");

    const envFilePath = `${workspace.root}/.wiki.env`;
    const envFile = readFile(envFilePath);
    expect(envFile).toContain("VAULT_SOURCE=synology");
    expect(envFile).toContain("VAULT_HASH_MODE=mtime");
    expect(envFile).toContain(`SYNOLOGY_BASE_URL=${server.baseUrl}`);
    expect(envFile).toContain("SYNOLOGY_USERNAME=tester");
    expect(envFile).toContain("SYNOLOGY_PASSWORD=secret");
    expect(envFile).toContain("VAULT_SYNOLOGY_REMOTE_PATH=/vault");
    expect(envFile).toContain("SYNOLOGY_VERIFY_SSL=true");
    expect(envFile).toContain("SYNOLOGY_READONLY=true");

    const doctor = runCli(["doctor", "--probe", "--format", "json"], env, { cwd: workspace.root });
    expect(doctor.status).toBe(0);
    const report = readJson<{
      ok: boolean;
      checks: Array<{ id: string; severity: string; summary: string }>;
    }>(doctor.stdout);
    expect(report.ok).toBe(true);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "vault-source", severity: "ok" }),
        expect.objectContaining({ id: "synology-config", severity: "ok" }),
        expect.objectContaining({ id: "synology-probe", severity: "ok" }),
      ]),
    );
  });

  it("reports actionable errors when the generated runtime assets are missing", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);

    const env = stripWikiEnv(workspace.env);
    const envFilePath = `${workspace.root}/.wiki.env`;
    const envFile = [
      `WIKI_PATH=${workspace.wikiPath}`,
      `VAULT_PATH=${workspace.vaultPath}`,
      `WIKI_DB_PATH=${workspace.wikiRoot}/index.db`,
      `WIKI_CONFIG_PATH=${workspace.wikiRoot}/wiki.config.json`,
      `WIKI_TEMPLATES_PATH=${workspace.wikiRoot}/templates`,
      "WIKI_PARSER_SKILLS=pdf,docx",
      "WIKI_SYNC_INTERVAL=86400",
      "",
    ].join("\n");
    writeFileSync(envFilePath, envFile, "utf8");

    const doctor = runCli(["doctor", "--format", "json"], env, {
      cwd: workspace.root,
      allowFailure: true,
    });
    expect(doctor.status).toBe(2);

    const report = readJson<{
      ok: boolean;
      recommendations: string[];
      skills: { requestedParserSkills: string[]; missingSkills: string[] };
      checks: Array<{ id: string; severity: string; summary: string }>;
    }>(doctor.stdout);
    expect(report.ok).toBe(false);
    expect(report.skills.requestedParserSkills).toEqual(["pdf", "docx"]);
    expect(report.skills.missingSkills).toEqual(expect.arrayContaining(["tiangong-wiki-skill", "pdf", "docx"]));
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "config", severity: "error" }),
        expect.objectContaining({ id: "templates-path", severity: "error" }),
        expect.objectContaining({ id: "skills-root", severity: "error" }),
        expect.objectContaining({ id: "tiangong-wiki-skill", severity: "error" }),
        expect.objectContaining({ id: "parser-skills", severity: "error" }),
      ]),
    );
    expect(report.recommendations.join("\n")).toContain("tiangong-wiki setup");
  });

  it("reports invalid parser skill declarations precisely", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);

    const env = stripWikiEnv(workspace.env);
    const envFilePath = `${workspace.root}/.wiki.env`;
    const envFile = [
      `WIKI_PATH=${workspace.wikiPath}`,
      `VAULT_PATH=${workspace.vaultPath}`,
      `WIKI_DB_PATH=${workspace.wikiRoot}/index.db`,
      `WIKI_CONFIG_PATH=${workspace.wikiRoot}/wiki.config.json`,
      `WIKI_TEMPLATES_PATH=${workspace.wikiRoot}/templates`,
      "WIKI_PARSER_SKILLS=pdf,unknown",
      "WIKI_SYNC_INTERVAL=86400",
      "",
    ].join("\n");
    writeFileSync(envFilePath, envFile, "utf8");

    const doctor = runCli(["doctor", "--format", "json"], env, {
      cwd: workspace.root,
      allowFailure: true,
    });
    expect(doctor.status).toBe(2);

    const report = readJson<{
      ok: boolean;
      skills: { requestedParserSkills: string[]; invalidParserSkills: string[] };
      checks: Array<{ id: string; severity: string; summary: string }>;
    }>(doctor.stdout);
    expect(report.ok).toBe(false);
    expect(report.skills.requestedParserSkills).toEqual(["pdf"]);
    expect(report.skills.invalidParserSkills).toEqual(["unknown"]);
    expect(report.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "parser-skills", severity: "error" })]),
    );
  });

  it("fails setup when a selected parser skill cannot be installed", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);

    const env = {
      ...stripWikiEnv(workspace.env),
      PATH: [createFakeSkillsInstaller(workspace.root, "failure"), process.env.PATH].filter(Boolean).join(path.delimiter),
    };
    const answers = [
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "n",
      "n",
      "y",
      "n",
      "n",
      "n",
      "y",
      "",
    ].join("\n");

    const setup = runCli(["setup"], env, {
      cwd: workspace.root,
      input: answers,
      allowFailure: true,
    });
    expect(setup.status).toBe(1);
    expect(setup.stderr).toContain("failed to install skill pdf");
    expect(setup.stderr).toContain("fake installer failure");
    expect(existsSync(path.join(workspace.root, ".wiki.env"))).toBe(false);
  });
});
