import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cleanupWorkspace, createWorkspace, runCliJson, type Workspace } from "../helpers.js";

function createFakeNpx(root: string): string {
  const fakeBin = path.join(root, "bin");
  mkdirSync(fakeBin, { recursive: true });
  const fakeNpx = path.join(fakeBin, "npx");
  const fakeNpxCmd = path.join(fakeBin, "npx.cmd");
  writeFileSync(
    fakeNpx,
    [
      "#!/bin/sh",
      "skill_name=\"\"",
      "source=\"\"",
      "seen_add=0",
      "while [ \"$#\" -gt 0 ]; do",
      "  if [ \"$1\" = \"add\" ]; then",
      "    seen_add=1",
      "    shift",
      "    if [ \"$#\" -gt 0 ]; then",
      "      source=\"$1\"",
      "    fi",
      "  elif [ \"$1\" = \"--skill\" ]; then",
      "    shift",
      "    skill_name=\"$1\"",
      "  fi",
      "  shift",
      "done",
      "version=\"${FAKE_SKILL_VERSION:-v1}\"",
      "mkdir -p \"$PWD/.agents/skills/$skill_name\"",
      "printf '%s\\n' '---' \"name: $skill_name\" \"description: fake $version\" '---' > \"$PWD/.agents/skills/$skill_name/SKILL.md\"",
      "printf '%s\\n' \"$version\" > \"$PWD/.agents/skills/$skill_name/VERSION.txt\"",
      "printf '%s\\n' \"$source\" > \"$PWD/.agents/skills/$skill_name/SOURCE.txt\"",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    fakeNpxCmd,
    [
      "@echo off",
      "set skill_name=",
      "set source=",
      "set seen_add=0",
      ":loop",
      "if \"%~1\"==\"\" goto done",
      "if \"%~1\"==\"add\" goto set_source",
      "if \"%~1\"==\"--skill\" goto set_skill",
      "shift",
      "goto loop",
      ":set_source",
      "set seen_add=1",
      "shift",
      "if not \"%~1\"==\"\" set \"source=%~1\"",
      "shift",
      "goto loop",
      ":set_skill",
      "shift",
      "set \"skill_name=%~1\"",
      "shift",
      "goto loop",
      ":done",
      "if not defined FAKE_SKILL_VERSION set FAKE_SKILL_VERSION=v1",
      "mkdir \"%CD%\\.agents\\skills\\%skill_name%\" 2>NUL",
      "> \"%CD%\\.agents\\skills\\%skill_name%\\SKILL.md\" echo ---",
      ">> \"%CD%\\.agents\\skills\\%skill_name%\\SKILL.md\" echo name: %skill_name%",
      ">> \"%CD%\\.agents\\skills\\%skill_name%\\SKILL.md\" echo description: fake %FAKE_SKILL_VERSION%",
      ">> \"%CD%\\.agents\\skills\\%skill_name%\\SKILL.md\" echo ---",
      "> \"%CD%\\.agents\\skills\\%skill_name%\\VERSION.txt\" echo %FAKE_SKILL_VERSION%",
      "> \"%CD%\\.agents\\skills\\%skill_name%\\SOURCE.txt\" echo %source%",
      "",
    ].join("\r\n"),
    "utf8",
  );
  chmodSync(fakeNpx, 0o755);
  return fakeBin;
}

describe("skill commands", () => {
  const workspaces: Workspace[] = [];
  const tempDirs: string[] = [];

  afterEach(() => {
    while (workspaces.length > 0) {
      cleanupWorkspace(workspaces.pop()!);
    }
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("installs parser skills and reports when upstream updates are available", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "wiki-skill-cli-"));
    tempDirs.push(tempRoot);
    const fakeBin = createFakeNpx(tempRoot);

    const workspace = createWorkspace({
      WIKI_PARSER_SKILLS: "pdf",
      PATH: [fakeBin, process.env.PATH].filter(Boolean).join(path.delimiter),
      FAKE_SKILL_VERSION: "v1",
    });
    workspaces.push(workspace);

    const install = runCliJson<{
      results: Array<{ name: string; action: string; state: string }>;
    }>(["skill", "update", "pdf", "--format", "json"], workspace.env);
    expect(install.results).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "pdf", action: "installed" })]),
    );

    const upToDate = runCliJson<{
      skills: Array<{ name: string; state: string; tracked: boolean }>;
    }>(["skill", "status", "pdf", "--format", "json"], workspace.env);
    expect(upToDate.skills).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "pdf", state: "up_to_date", tracked: true })]),
    );

    const nextEnv = { ...workspace.env, FAKE_SKILL_VERSION: "v2" };
    const updateAvailable = runCliJson<{
      skills: Array<{ name: string; state: string }>;
    }>(["skill", "status", "pdf", "--format", "json"], nextEnv);
    expect(updateAvailable.skills).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "pdf", state: "update_available" })]),
    );

    const updated = runCliJson<{
      results: Array<{ name: string; action: string; state: string }>;
    }>(["skill", "update", "pdf", "--format", "json"], nextEnv);
    expect(updated.results).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "pdf", action: "updated", state: "up_to_date" })]),
    );

    const installedVersion = readFileSync(path.join(workspace.root, ".agents", "skills", "pdf", "VERSION.txt"), "utf8").trim();
    expect(installedVersion).toBe("v2");
  });

  it("detects local conflicts and refuses to overwrite them without --force", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "wiki-skill-cli-"));
    tempDirs.push(tempRoot);
    const fakeBin = createFakeNpx(tempRoot);

    const workspace = createWorkspace({
      WIKI_PARSER_SKILLS: "pdf",
      PATH: [fakeBin, process.env.PATH].filter(Boolean).join(path.delimiter),
      FAKE_SKILL_VERSION: "v1",
    });
    workspaces.push(workspace);

    runCliJson(["skill", "update", "pdf", "--format", "json"], workspace.env);
    const skillMdPath = path.join(workspace.root, ".agents", "skills", "pdf", "SKILL.md");
    writeFileSync(skillMdPath, `${readFileSync(skillMdPath, "utf8")}\nlocal note\n`, "utf8");

    const conflict = runCliJson<{
      skills: Array<{ name: string; state: string }>;
    }>(["skill", "status", "pdf", "--format", "json"], workspace.env);
    expect(conflict.skills).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "pdf", state: "conflict" })]),
    );

    const refused = runCliJson<{
      results: Array<{ name: string; action: string; state: string; message: string }>;
    }>(["skill", "update", "pdf", "--format", "json"], workspace.env);
    expect(refused.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "pdf",
          action: "skipped",
          state: "conflict",
          message: expect.stringContaining("--force"),
        }),
      ]),
    );

    const forced = runCliJson<{
      results: Array<{ name: string; action: string; state: string }>;
    }>(["skill", "update", "pdf", "--force", "--format", "json"], workspace.env);
    expect(forced.results).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "pdf", action: "updated", state: "up_to_date" })]),
    );
    expect(readFileSync(skillMdPath, "utf8")).not.toContain("local note");
  });

  it("adds path-sourced skills and keeps them manageable via status and update", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "wiki-skill-cli-"));
    tempDirs.push(tempRoot);
    const fakeBin = createFakeNpx(tempRoot);
    const sourcePath = path.join(tempRoot, "skill source repo");
    mkdirSync(sourcePath, { recursive: true });

    const workspace = createWorkspace({
      PATH: [fakeBin, process.env.PATH].filter(Boolean).join(path.delimiter),
      FAKE_SKILL_VERSION: "v1",
    });
    workspaces.push(workspace);

    const added = runCliJson<{
      results: Array<{ name: string; action: string; state: string }>;
    }>(["skill", "add", sourcePath, "--skill", "notes", "--format", "json"], workspace.env);
    expect(added.results).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "notes", action: "installed", state: "up_to_date" })]),
    );

    const statusAll = runCliJson<{
      skills: Array<{ name: string; state: string; source: string }>;
    }>(["skill", "status", "--format", "json"], workspace.env);
    expect(statusAll.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "notes", state: "up_to_date", source: sourcePath }),
      ]),
    );

    const nextEnv = { ...workspace.env, FAKE_SKILL_VERSION: "v2" };
    const updateAvailable = runCliJson<{
      skills: Array<{ name: string; state: string }>;
    }>(["skill", "status", "notes", "--format", "json"], nextEnv);
    expect(updateAvailable.skills).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "notes", state: "update_available" })]),
    );

    const updated = runCliJson<{
      results: Array<{ name: string; action: string; state: string }>;
    }>(["skill", "update", "notes", "--format", "json"], nextEnv);
    expect(updated.results).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "notes", action: "updated", state: "up_to_date" })]),
    );

    const skillRoot = path.join(workspace.root, ".agents", "skills", "notes");
    expect(readFileSync(path.join(skillRoot, "VERSION.txt"), "utf8").trim()).toBe("v2");
    expect(readFileSync(path.join(skillRoot, "SOURCE.txt"), "utf8").trim()).toBe(sourcePath);
  });

  it("refuses to overwrite local edits for path-sourced skills without --force", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "wiki-skill-cli-"));
    tempDirs.push(tempRoot);
    const fakeBin = createFakeNpx(tempRoot);
    const sourcePath = path.join(tempRoot, "custom skill source");
    mkdirSync(sourcePath, { recursive: true });

    const workspace = createWorkspace({
      PATH: [fakeBin, process.env.PATH].filter(Boolean).join(path.delimiter),
      FAKE_SKILL_VERSION: "v1",
    });
    workspaces.push(workspace);

    runCliJson(["skill", "add", sourcePath, "--skill", "notes", "--format", "json"], workspace.env);
    const skillMdPath = path.join(workspace.root, ".agents", "skills", "notes", "SKILL.md");
    writeFileSync(skillMdPath, `${readFileSync(skillMdPath, "utf8")}\nlocal note\n`, "utf8");

    const conflict = runCliJson<{
      skills: Array<{ name: string; state: string }>;
    }>(["skill", "status", "notes", "--format", "json"], workspace.env);
    expect(conflict.skills).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "notes", state: "conflict" })]),
    );

    const refused = runCliJson<{
      results: Array<{ name: string; action: string; state: string; message: string }>;
    }>(["skill", "update", "notes", "--format", "json"], workspace.env);
    expect(refused.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "notes",
          action: "skipped",
          state: "conflict",
          message: expect.stringContaining("--force"),
        }),
      ]),
    );

    const forced = runCliJson<{
      results: Array<{ name: string; action: string; state: string }>;
    }>(["skill", "update", "notes", "--force", "--format", "json"], workspace.env);
    expect(forced.results).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "notes", action: "updated", state: "up_to_date" })]),
    );
    expect(readFileSync(skillMdPath, "utf8")).not.toContain("local note");
  });

  it("can install the workspace-local tiangong-wiki-skill symlink", () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);

    const before = runCliJson<{
      skills: Array<{ name: string; state: string }>;
    }>(["skill", "status", "tiangong-wiki-skill", "--format", "json"], workspace.env);
    expect(before.skills).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "tiangong-wiki-skill", state: "missing" })]),
    );

    const updated = runCliJson<{
      results: Array<{ name: string; action: string; state: string }>;
    }>(["skill", "update", "tiangong-wiki-skill", "--format", "json"], workspace.env);
    expect(updated.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "tiangong-wiki-skill", action: "installed", state: "up_to_date" }),
      ]),
    );

    expect(existsSync(path.join(workspace.root, ".agents", "skills", "tiangong-wiki-skill", "SKILL.md"))).toBe(true);
  });
});
