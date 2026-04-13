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
    const configHome = path.join(workspace.root, ".config-home");

    const env = {
      ...stripWikiEnv(workspace.env),
      XDG_CONFIG_HOME: configHome,
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
    const globalConfigPath = setup.stdout.match(/default workspace config: (.+)/)?.[1]?.trim();
    expect(envFile).toContain("WIKI_PATH=");
    expect(envFile).toContain("VAULT_PATH=");
    expect(envFile).toContain("WIKI_AGENT_ENABLED=false");
    expect(envFile).toContain("WIKI_PARSER_SKILLS=pdf");
    expect(globalConfigPath).toBeTruthy();
    expect(readFile(globalConfigPath!)).toContain(realpathSync(envFilePath));
    expect(readFile(path.join(workspace.root, ".agents", "skills", "tiangong-wiki-skill", "SKILL.md"))).toContain(
      "name: tiangong-wiki-skill",
    );
    expect(readFile(path.join(workspace.root, ".agents", "skills", "pdf", "SKILL.md"))).toContain("name: pdf");

    const doctor = runCli(["doctor", "--format", "json"], env, { cwd: workspace.root });
    expect(doctor.status).toBe(0);
    const report = readJson<{
      ok: boolean;
      envFile: { loadedPath: string | null; source: string; globalConfigPath: string | null };
      skills: { requestedParserSkills: string[]; missingSkills: string[] };
      checks: Array<{ id: string; severity: string }>;
    }>(doctor.stdout);
    expect(report.ok).toBe(true);
    expect(report.envFile.loadedPath).toBe(realpathSync(envFilePath));
    expect(report.envFile.source).toBe("nearest-env-file");
    expect(report.envFile.globalConfigPath).toBeNull();
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

    const doctorFromOutside = runCli(["doctor", "--format", "json"], env, { cwd: path.dirname(workspace.root) });
    expect(doctorFromOutside.status).toBe(0);
    const outsideReport = readJson<{
      ok: boolean;
      envFile: { loadedPath: string | null; source: string; globalConfigPath: string | null };
    }>(doctorFromOutside.stdout);
    expect(outsideReport.ok).toBe(true);
    expect(outsideReport.envFile.loadedPath).toBe(realpathSync(envFilePath));
    expect(outsideReport.envFile.source).toBe("global-default-env-file");
    expect(outsideReport.envFile.globalConfigPath).toBe(globalConfigPath);

    const doctorWithExplicitEnv = runCli(["--env-file", envFilePath, "doctor", "--format", "json"], env, {
      cwd: path.dirname(workspace.root),
    });
    expect(doctorWithExplicitEnv.status).toBe(0);
    const explicitReport = readJson<{
      envFile: { loadedPath: string | null; source: string };
    }>(doctorWithExplicitEnv.stdout);
    expect(explicitReport.envFile.loadedPath).toBe(path.resolve(envFilePath));
    expect(explicitReport.envFile.source).toBe("explicit-env-file");
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
    env.XDG_CONFIG_HOME = path.join(workspace.root, ".config-home");
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
      XDG_CONFIG_HOME: path.join(workspace.root, ".config-home"),
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

  it("explains clearly when no workspace configuration can be resolved", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);

    const env = {
      ...stripWikiEnv(workspace.env),
      XDG_CONFIG_HOME: path.join(workspace.root, ".empty-config-home"),
    };
    const outsideCwd = path.dirname(workspace.root);
    const doctor = runCli(["doctor", "--format", "json"], env, {
      cwd: outsideCwd,
      allowFailure: true,
    });
    expect(doctor.status).toBe(2);

    const report = readJson<{
      envFile: { loadedPath: string | null; source: string };
      checks: Array<{ id: string; severity: string; summary: string; recommendation?: string }>;
      recommendations: string[];
    }>(doctor.stdout);
    expect(report.envFile.loadedPath).toBeNull();
    expect(report.envFile.source).toBe("none");
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "env-file",
          severity: "warn",
          summary: expect.stringContaining("No workspace configuration was found"),
        }),
      ]),
    );
    expect(report.recommendations.join("\n")).toContain("--env-file");
    expect(report.recommendations.join("\n")).toContain("WIKI_ENV_FILE");
  });
});
