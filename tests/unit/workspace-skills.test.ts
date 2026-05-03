import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildExternalSkillInstallInvocation,
  buildExternalSkillInstallSpawnInvocation,
  ensureWikiSkillInstall,
  getNpxCommand,
  installParserSkill,
  parseParserSkills,
  resolveWorkspaceSkillPaths,
} from "../../src/core/workspace-skills.js";

describe("workspace skills", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("parses parser skills and rejects unknown names in strict mode", () => {
    expect(parseParserSkills("pdf, docx,pdf")).toEqual(["pdf", "docx"]);
    expect(parseParserSkills("", { strict: false })).toEqual([]);
    expect(() => parseParserSkills("pdf,unknown")).toThrow(/unsupported skills/i);
  });

  it("uses the npm .cmd shim for external skill installs on Windows", () => {
    expect(getNpxCommand("win32")).toBe("npx.cmd");
    expect(getNpxCommand("darwin")).toBe("npx");
    expect(getNpxCommand("linux")).toBe("npx");
    expect(buildExternalSkillInstallInvocation("repo", "pdf").args).toContain("--skill");
    expect(buildExternalSkillInstallInvocation("custom skill source", "pdf").rendered).toContain('"custom skill source"');

    const invocation = {
      ...buildExternalSkillInstallInvocation("custom skill source", "pdf"),
      command: getNpxCommand("win32"),
    };
    expect(buildExternalSkillInstallSpawnInvocation(invocation, "win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" })).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        '"npx.cmd" "-y" "skills" "add" "custom skill source" "--skill" "pdf" "-a" "codex" "-y"',
      ],
    });
  });

  it("creates a workspace-local tiangong-wiki-skill symlink", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wiki-workspace-skills-"));
    tempDirs.push(root);

    const wikiPath = path.join(root, "wiki", "pages");
    const packageRoot = path.join(root, "package");
    mkdirSync(wikiPath, { recursive: true });
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(path.join(packageRoot, "SKILL.md"), "---\nname: tiangong-wiki-skill\ndescription: test\n---\n", "utf8");

    const installed = ensureWikiSkillInstall(wikiPath, packageRoot);
    const paths = resolveWorkspaceSkillPaths(wikiPath);

    expect(installed.skillPath).toBe(paths.wikiSkillPath);
    expect(installed.status).toBe("linked");
  });

  it("replaces an existing copied tiangong-wiki-skill directory with a symlink", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wiki-workspace-skills-"));
    tempDirs.push(root);

    const wikiPath = path.join(root, "wiki", "pages");
    const packageRoot = path.join(root, "package");
    const copiedSkillPath = path.join(root, ".agents", "skills", "tiangong-wiki-skill");
    mkdirSync(wikiPath, { recursive: true });
    mkdirSync(packageRoot, { recursive: true });
    mkdirSync(copiedSkillPath, { recursive: true });
    writeFileSync(path.join(packageRoot, "SKILL.md"), "---\nname: tiangong-wiki-skill\ndescription: package\n---\n", "utf8");
    writeFileSync(path.join(copiedSkillPath, "SKILL.md"), "---\nname: tiangong-wiki-skill\ndescription: copied\n---\n", "utf8");

    const installed = ensureWikiSkillInstall(wikiPath, packageRoot);

    expect(installed.status).toBe("updated");
    if (process.platform !== "win32") {
      expect(lstatSync(copiedSkillPath).isSymbolicLink()).toBe(true);
    }
    expect(realpathSync(copiedSkillPath)).toBe(realpathSync(packageRoot));
  });

  it("installs parser skills through the external installer command", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wiki-workspace-skills-"));
    tempDirs.push(root);

    const workspaceRoot = path.join(root, "workspace");
    const fakeBin = path.join(root, "bin");
    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });

    const fakeNpx = path.join(fakeBin, "npx");
    const fakeNpxCmd = path.join(fakeBin, "npx.cmd");
    writeFileSync(
      fakeNpx,
      [
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
        "printf '%s\\n' '---' \"name: $skill_name\" 'description: fake' '---' > \"$PWD/.agents/skills/$skill_name/SKILL.md\"",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      fakeNpxCmd,
      [
        "@echo off",
        "set skill_name=",
        ":loop",
        "if \"%~1\"==\"\" goto done",
        "if \"%~1\"==\"--skill\" (",
        "  shift",
        "  set skill_name=%~1",
        ")",
        "shift",
        "goto loop",
        ":done",
        "mkdir \"%CD%\\.agents\\skills\\%skill_name%\" 2>NUL",
        "> \"%CD%\\.agents\\skills\\%skill_name%\\SKILL.md\" echo ---",
        ">> \"%CD%\\.agents\\skills\\%skill_name%\\SKILL.md\" echo name: %skill_name%",
        ">> \"%CD%\\.agents\\skills\\%skill_name%\\SKILL.md\" echo description: fake",
        ">> \"%CD%\\.agents\\skills\\%skill_name%\\SKILL.md\" echo ---",
        "",
      ].join("\r\n"),
      "utf8",
    );
    chmodSync(fakeNpx, 0o755);

    const result = installParserSkill("pdf", workspaceRoot, {
      env: {
        ...process.env,
        PATH: [fakeBin, process.env.PATH].filter(Boolean).join(path.delimiter),
      },
    });

    expect(result.status).toBe("installed");
    expect(result.skillMdPath).toBe(path.join(workspaceRoot, ".agents", "skills", "pdf", "SKILL.md"));
  });
});
