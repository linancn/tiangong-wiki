import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { AppError } from "../utils/errors.js";
import { copyDirectoryContentsSync, ensureDirSync, pathExistsSync, readTextFileSync, writeTextFileSync } from "../utils/fs.js";
import { resolveRuntimePaths } from "./paths.js";
import { toOffsetIso } from "../utils/time.js";

export const PARSER_SKILL_SOURCE = "https://github.com/anthropics/skills";
export const MANAGED_SKILL_STATE_FILE = ".tiangong-wiki-skill.json";

export const OPTIONAL_PARSER_SKILLS = [
  { name: "pdf", summary: "Process PDF files" },
  { name: "docx", summary: "Process DOCX files" },
  { name: "pptx", summary: "Process PPTX files" },
  { name: "xlsx", summary: "Process XLSX/CSV files" },
] as const;

export type ParserSkillName = (typeof OPTIONAL_PARSER_SKILLS)[number]["name"];

export interface WorkspaceSkillPaths {
  workspaceRoot: string;
  skillsRoot: string;
  wikiSkillPath: string;
}

export interface SkillCheckResult {
  name: string;
  skillPath: string;
  skillMdPath: string;
  exists: boolean;
  readable: boolean;
}

export interface WikiSkillInstallResult {
  sourcePath: string;
  skillPath: string;
  status: "linked" | "updated" | "existing";
}

export interface ParserSkillInstallResult {
  name: ParserSkillName;
  skillPath: string;
  skillMdPath: string;
  status: "installed" | "existing";
  command: string;
}

export interface ExternalSkillInstallResult {
  name: string;
  source: string;
  skillPath: string;
  skillMdPath: string;
  status: "installed" | "existing";
  command: string;
}

export interface ParserSkillSelection {
  skills: ParserSkillName[];
  invalid: string[];
}

export type ManagedSkillSourceKind = "workspace-package" | "curated-parser" | "external-source";
export type ManagedSkillState = "up_to_date" | "update_available" | "conflict" | "missing";
export type ManagedSkillUpdateAction = "installed" | "updated" | "unchanged" | "skipped";

export interface ManagedSkillMetadata {
  version: 1;
  skillName: string;
  sourceKind: ManagedSkillSourceKind;
  source: string;
  installedAt: string;
  baselineHash: string;
  command?: string;
}

export interface ManagedSkillDescriptor {
  name: string;
  sourceKind: ManagedSkillSourceKind;
  configured: boolean;
  source: string;
  skillPath: string;
}

export interface ManagedSkillStatus {
  name: string;
  sourceKind: ManagedSkillSourceKind;
  configured: boolean;
  source: string;
  skillPath: string;
  state: ManagedSkillState;
  tracked: boolean;
  message: string;
}

export interface ManagedSkillUpdateResult extends ManagedSkillStatus {
  action: ManagedSkillUpdateAction;
}

const OPTIONAL_PARSER_SKILL_NAMES = new Set<ParserSkillName>(OPTIONAL_PARSER_SKILLS.map((skill) => skill.name));
const MANAGED_SKILL_SOURCE_KINDS = new Set<ManagedSkillSourceKind>([
  "workspace-package",
  "curated-parser",
  "external-source",
]);

function canRead(filePath: string): boolean {
  accessSync(filePath, constants.R_OK);
  return true;
}

export function getNpxCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "npx.cmd" : "npx";
}

export function resolveWorkspaceRootFromWikiPath(wikiPath: string): string {
  return path.resolve(wikiPath, "..", "..");
}

export function resolveWorkspaceSkillPaths(wikiPath: string): WorkspaceSkillPaths {
  const workspaceRoot = resolveWorkspaceRootFromWikiPath(wikiPath);
  const skillsRoot = path.join(workspaceRoot, ".agents", "skills");

  return {
    workspaceRoot,
    skillsRoot,
    wikiSkillPath: path.join(skillsRoot, "tiangong-wiki-skill"),
  };
}

export function resolveWorkspaceSkillPath(workspaceRoot: string, skillName: string): string {
  return path.join(workspaceRoot, ".agents", "skills", skillName);
}

export function parseParserSkillSelection(rawValue: string | undefined): ParserSkillSelection {
  const value = rawValue?.trim();
  if (!value) {
    return {
      skills: [],
      invalid: [],
    };
  }

  const skills: ParserSkillName[] = [];
  const seen = new Set<ParserSkillName>();
  const invalid: string[] = [];

  for (const entry of value.split(",")) {
    const candidate = entry.trim().toLowerCase();
    if (!candidate) {
      continue;
    }

    if (!OPTIONAL_PARSER_SKILL_NAMES.has(candidate as ParserSkillName)) {
      invalid.push(candidate);
      continue;
    }

    const skill = candidate as ParserSkillName;
    if (!seen.has(skill)) {
      seen.add(skill);
      skills.push(skill);
    }
  }

  return {
    skills,
    invalid,
  };
}

export function parseParserSkills(
  rawValue: string | undefined,
  options: { strict?: boolean } = {},
): ParserSkillName[] {
  const { skills, invalid } = parseParserSkillSelection(rawValue);

  if (invalid.length > 0 && options.strict !== false) {
    throw new AppError(
      `WIKI_PARSER_SKILLS contains unsupported skills: ${invalid.join(", ")}`,
      "config",
    );
  }

  return skills;
}

export function formatParserSkills(skills: readonly ParserSkillName[]): string {
  return skills.join(",");
}

export function inspectSkillInstall(skillPath: string, name = path.basename(skillPath)): SkillCheckResult {
  const skillMdPath = path.join(skillPath, "SKILL.md");
  if (!pathExistsSync(skillPath)) {
    return {
      name,
      skillPath,
      skillMdPath,
      exists: false,
      readable: false,
    };
  }

  try {
    canRead(skillMdPath);
    return {
      name,
      skillPath,
      skillMdPath,
      exists: true,
      readable: true,
    };
  } catch {
    return {
      name,
      skillPath,
      skillMdPath,
      exists: true,
      readable: false,
    };
  }
}

function getManagedSkillStatePath(skillPath: string): string {
  return path.join(skillPath, MANAGED_SKILL_STATE_FILE);
}

function readManagedSkillMetadata(skillPath: string): ManagedSkillMetadata | null {
  const metadataPath = getManagedSkillStatePath(skillPath);
  if (!pathExistsSync(metadataPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readTextFileSync(metadataPath)) as Partial<ManagedSkillMetadata>;
    if (
      parsed.version !== 1 ||
      typeof parsed.skillName !== "string" ||
      typeof parsed.sourceKind !== "string" ||
      !MANAGED_SKILL_SOURCE_KINDS.has(parsed.sourceKind as ManagedSkillSourceKind) ||
      typeof parsed.source !== "string" ||
      typeof parsed.installedAt !== "string" ||
      typeof parsed.baselineHash !== "string"
    ) {
      return null;
    }

    return {
      version: 1,
      skillName: parsed.skillName,
      sourceKind: parsed.sourceKind as ManagedSkillSourceKind,
      source: parsed.source,
      installedAt: parsed.installedAt,
      baselineHash: parsed.baselineHash,
      ...(typeof parsed.command === "string" ? { command: parsed.command } : {}),
    };
  } catch {
    return null;
  }
}

function writeManagedSkillMetadata(skillPath: string, metadata: ManagedSkillMetadata): void {
  writeTextFileSync(getManagedSkillStatePath(skillPath), `${JSON.stringify(metadata, null, 2)}\n`);
}

function hashSkillDirectory(skillPath: string): string {
  const hash = createHash("sha256");

  const visit = (dirPath: string, relativePrefix: string): void => {
    const entries = readdirSync(dirPath, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === MANAGED_SKILL_STATE_FILE) {
        continue;
      }

      const absolutePath = path.join(dirPath, entry.name);
      const relativePath = path.posix.join(relativePrefix, entry.name);
      const stats = lstatSync(absolutePath);

      if (stats.isSymbolicLink()) {
        hash.update(`symlink:${relativePath}:${realpathSync(absolutePath)}\n`);
        continue;
      }

      if (stats.isDirectory()) {
        hash.update(`dir:${relativePath}\n`);
        visit(absolutePath, relativePath);
        continue;
      }

      hash.update(`file:${relativePath}\n`);
      hash.update(readFileSync(absolutePath));
    }
  };

  visit(skillPath, "");
  return hash.digest("hex");
}

function getWorkspaceRootForSkillPath(skillPath: string): string {
  return path.dirname(path.dirname(path.dirname(skillPath)));
}

function replaceSkillDirectory(targetPath: string, sourcePath: string): void {
  rmSync(targetPath, { recursive: true, force: true });
  ensureDirSync(targetPath);
  copyDirectoryContentsSync(sourcePath, targetPath);
}

function linkWorkspaceSkill(sourcePath: string, targetPath: string): void {
  symlinkSync(sourcePath, targetPath, process.platform === "win32" ? "junction" : "dir");
}

function createManagedSkillMetadata(
  descriptor: ManagedSkillDescriptor,
  baselineHash: string,
  command?: string,
): ManagedSkillMetadata {
  return {
    version: 1,
    skillName: descriptor.name,
    sourceKind: descriptor.sourceKind,
    source: descriptor.source,
    installedAt: toOffsetIso(),
    baselineHash,
    ...(command ? { command } : {}),
  };
}

function ensureParserSkillName(rawName: string): ParserSkillName {
  const normalized = rawName.trim().toLowerCase();
  if (!OPTIONAL_PARSER_SKILL_NAMES.has(normalized as ParserSkillName)) {
    throw new AppError(`Unsupported parser skill: ${rawName}`, "config");
  }
  return normalized as ParserSkillName;
}

function normalizeCustomSkillName(rawName: string): string {
  const name = rawName.trim();
  if (!name) {
    throw new AppError("Skill name must not be empty.", "config");
  }
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new AppError(`Skill name must be a single directory-friendly token, got ${rawName}`, "config");
  }
  if (name === "tiangong-wiki-skill") {
    throw new AppError("Skill name tiangong-wiki-skill is reserved for the workspace package skill.", "config");
  }
  return name;
}

function normalizeManagedSource(rawSource: string): string {
  const source = rawSource.trim();
  if (!source) {
    throw new AppError("Skill source must not be empty.", "config");
  }
  return source;
}

function createParserDescriptor(workspaceRoot: string, name: ParserSkillName, configured: boolean): ManagedSkillDescriptor {
  return {
    name,
    sourceKind: "curated-parser",
    configured,
    source: PARSER_SKILL_SOURCE,
    skillPath: resolveWorkspaceSkillPath(workspaceRoot, name),
  };
}

function createExternalDescriptor(workspaceRoot: string, name: string, source: string): ManagedSkillDescriptor {
  const normalizedName = normalizeCustomSkillName(name);
  return {
    name: normalizedName,
    sourceKind: "external-source",
    configured: true,
    source: normalizeManagedSource(source),
    skillPath: resolveWorkspaceSkillPath(workspaceRoot, normalizedName),
  };
}

function createWikiDescriptor(wikiPath: string, packageRoot: string): ManagedSkillDescriptor {
  const paths = resolveWorkspaceSkillPaths(wikiPath);
  return {
    name: "tiangong-wiki-skill",
    sourceKind: "workspace-package",
    configured: true,
    source: packageRoot,
    skillPath: paths.wikiSkillPath,
  };
}

function renderCommand(command: string, args: string[]): string {
  return [command, ...args]
    .map((part) => (/^[A-Za-z0-9_./:@+-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(" ");
}

export function buildExternalSkillInstallInvocation(source: string, skillName: string): {
  command: string;
  args: string[];
  rendered: string;
} {
  const command = getNpxCommand();
  const args = ["-y", "skills", "add", source, "--skill", skillName, "-a", "codex", "-y"];
  return {
    command,
    args,
    rendered: renderCommand(command, args),
  };
}

export function buildExternalSkillInstallSpawnInvocation(
  invocation: { command: string; args: string[] },
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  if (platform !== "win32") {
    return {
      command: invocation.command,
      args: invocation.args,
    };
  }

  return {
    command: env.ComSpec?.trim() || "cmd.exe",
    args: ["/d", "/c", "call", invocation.command, ...invocation.args],
  };
}

function installManagedExternalSkill(
  descriptor: ManagedSkillDescriptor,
  options: {
    env?: NodeJS.ProcessEnv;
    output?: NodeJS.WritableStream;
    trackMetadata?: boolean;
    skipIfExists?: boolean;
  } = {},
): ExternalSkillInstallResult {
  if (descriptor.sourceKind === "workspace-package") {
    throw new AppError("Workspace package skills must be installed via ensureWikiSkillInstall.", "config");
  }

  const current = inspectSkillInstall(descriptor.skillPath, descriptor.name);
  const invocation = buildExternalSkillInstallInvocation(descriptor.source, descriptor.name);
  if (current.readable && options.skipIfExists !== false) {
    return {
      name: descriptor.name,
      source: descriptor.source,
      skillPath: descriptor.skillPath,
      skillMdPath: current.skillMdPath,
      status: "existing",
      command: invocation.rendered,
    };
  }

  const workspaceRoot = getWorkspaceRootForSkillPath(descriptor.skillPath);
  options.output?.write(`Installing skill ${descriptor.name} from ${descriptor.source}...\n`);
  const spawnInvocation = buildExternalSkillInstallSpawnInvocation(invocation);
  const result = spawnSync(spawnInvocation.command, spawnInvocation.args, {
    cwd: workspaceRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    windowsHide: true,
  });

  if (result.error) {
    throw new AppError(
      `failed to install skill ${descriptor.name}: ${result.error.message}`,
      "runtime",
      {
        skillName: descriptor.name,
        source: descriptor.source,
        command: invocation.rendered,
        cwd: workspaceRoot,
      },
    );
  }

  if (result.status !== 0) {
    throw new AppError(
      `failed to install skill ${descriptor.name}`,
      "runtime",
      {
        skillName: descriptor.name,
        source: descriptor.source,
        command: invocation.rendered,
        cwd: workspaceRoot,
        exitCode: result.status,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
      },
    );
  }

  const installed = inspectSkillInstall(descriptor.skillPath, descriptor.name);
  if (!installed.readable) {
    throw new AppError(
      `skill ${descriptor.name} was installed but SKILL.md is missing or unreadable`,
      "runtime",
      {
        skillName: descriptor.name,
        source: descriptor.source,
        command: invocation.rendered,
        cwd: workspaceRoot,
        skillPath: descriptor.skillPath,
        skillMdPath: installed.skillMdPath,
      },
    );
  }

  if (options.trackMetadata !== false) {
    writeManagedSkillMetadata(
      descriptor.skillPath,
      createManagedSkillMetadata(descriptor, hashSkillDirectory(descriptor.skillPath), invocation.rendered),
    );
  }

  return {
    name: descriptor.name,
    source: descriptor.source,
    skillPath: descriptor.skillPath,
    skillMdPath: installed.skillMdPath,
    status: "installed",
    command: invocation.rendered,
  };
}

function installManagedExternalSkillIntoTempWorkspace(
  descriptor: ManagedSkillDescriptor,
  options: { env?: NodeJS.ProcessEnv } = {},
): { hash: string; tempRoot: string; invocation: string } {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "tiangong-wiki-skill-update-"));
  try {
    const result = installManagedExternalSkill(
      {
        ...descriptor,
        skillPath: resolveWorkspaceSkillPath(tempRoot, descriptor.name),
      },
      {
        env: options.env,
        trackMetadata: false,
      },
    );
    return {
      hash: hashSkillDirectory(resolveWorkspaceSkillPath(tempRoot, descriptor.name)),
      tempRoot,
      invocation: result.command,
    };
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

function hasCompatibleManagedMetadata(
  metadata: ManagedSkillMetadata | null,
  descriptor: ManagedSkillDescriptor,
): metadata is ManagedSkillMetadata {
  return metadata !== null &&
    metadata.skillName === descriptor.name &&
    metadata.sourceKind === descriptor.sourceKind &&
    metadata.source === descriptor.source;
}

function readManagedSkillDescriptorsFromMetadata(
  workspaceRoot: string,
  options: { includeSourceKinds?: ManagedSkillSourceKind[] } = {},
): ManagedSkillDescriptor[] {
  const skillsRoot = path.join(workspaceRoot, ".agents", "skills");
  if (!pathExistsSync(skillsRoot)) {
    return [];
  }

  const includeKinds = options.includeSourceKinds ? new Set(options.includeSourceKinds) : null;
  const descriptors: ManagedSkillDescriptor[] = [];
  const entries = readdirSync(skillsRoot, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }

    const skillPath = path.join(skillsRoot, entry.name);
    const metadata = readManagedSkillMetadata(skillPath);
    if (!metadata || metadata.skillName !== entry.name) {
      continue;
    }
    if (includeKinds && !includeKinds.has(metadata.sourceKind)) {
      continue;
    }

    descriptors.push({
      name: metadata.skillName,
      sourceKind: metadata.sourceKind,
      configured: true,
      source: metadata.source,
      skillPath,
    });
  }

  return descriptors;
}

function createManagedSkillCatalog(
  env: NodeJS.ProcessEnv = process.env,
): {
  wikiDescriptor: ManagedSkillDescriptor;
  configuredParserDescriptors: ManagedSkillDescriptor[];
  discoveredDescriptors: ManagedSkillDescriptor[];
} {
  const paths = resolveRuntimePaths(env);
  const workspace = resolveWorkspaceSkillPaths(paths.wikiPath);
  const configuredParserSkills = parseParserSkills(env.WIKI_PARSER_SKILLS, { strict: false });

  return {
    wikiDescriptor: createWikiDescriptor(paths.wikiPath, paths.packageRoot),
    configuredParserDescriptors: configuredParserSkills.map((name) =>
      createParserDescriptor(workspace.workspaceRoot, name, true),
    ),
    discoveredDescriptors: readManagedSkillDescriptorsFromMetadata(workspace.workspaceRoot),
  };
}

function resolveManagedSkillDescriptorByName(
  env: NodeJS.ProcessEnv,
  name: string,
): ManagedSkillDescriptor {
  const catalog = createManagedSkillCatalog(env);
  if (name === "tiangong-wiki-skill") {
    return catalog.wikiDescriptor;
  }

  const discovered = catalog.discoveredDescriptors.find((descriptor) => descriptor.name === name);
  if (discovered) {
    return discovered;
  }

  if (OPTIONAL_PARSER_SKILL_NAMES.has(name as ParserSkillName)) {
    return createParserDescriptor(
      getWorkspaceRootForSkillPath(catalog.wikiDescriptor.skillPath),
      name as ParserSkillName,
      catalog.configuredParserDescriptors.some((descriptor) => descriptor.name === name),
    );
  }

  throw new AppError(`Unknown managed skill: ${name}`, "config");
}

function resolveManagedSkillDescriptors(
  env: NodeJS.ProcessEnv = process.env,
  names?: string[],
): ManagedSkillDescriptor[] {
  if (names && names.length > 0) {
    return names.map((name) => resolveManagedSkillDescriptorByName(env, name));
  }

  const catalog = createManagedSkillCatalog(env);
  const descriptors = new Map<string, ManagedSkillDescriptor>();
  for (const descriptor of catalog.discoveredDescriptors) {
    if (descriptor.sourceKind === "external-source") {
      descriptors.set(descriptor.name, descriptor);
    }
  }
  descriptors.set(catalog.wikiDescriptor.name, catalog.wikiDescriptor);
  for (const descriptor of catalog.configuredParserDescriptors) {
    if (!descriptors.has(descriptor.name)) {
      descriptors.set(descriptor.name, descriptor);
    }
  }

  return [...descriptors.values()];
}

function getWikiSkillStatus(descriptor: ManagedSkillDescriptor): ManagedSkillStatus {
  const current = inspectSkillInstall(descriptor.skillPath, descriptor.name);
  if (!current.readable) {
    return {
      ...descriptor,
      state: "missing",
      tracked: false,
      message: "Skill is missing or unreadable.",
    };
  }

  const stats = lstatSync(descriptor.skillPath);
  if (!stats.isSymbolicLink()) {
    return {
      ...descriptor,
      state: "conflict",
      tracked: false,
      message: "Workspace skill path is a local directory, not the managed symlink target.",
    };
  }

  if (realpathSync(descriptor.skillPath) !== realpathSync(descriptor.source)) {
    return {
      ...descriptor,
      state: "update_available",
      tracked: true,
      message: "Symlink points to an older or different package root.",
    };
  }

  return {
    ...descriptor,
    state: "up_to_date",
    tracked: true,
    message: "Symlink points to the current package root.",
  };
}

function getExternalManagedSkillStatus(
  descriptor: ManagedSkillDescriptor,
  env: NodeJS.ProcessEnv = process.env,
): ManagedSkillStatus {
  const current = inspectSkillInstall(descriptor.skillPath, descriptor.name);
  if (!current.readable) {
    return {
      ...descriptor,
      state: "missing",
      tracked: false,
      message: "Skill is missing or unreadable.",
    };
  }

  const currentHash = hashSkillDirectory(descriptor.skillPath);
  const metadata = readManagedSkillMetadata(descriptor.skillPath);
  const latest = installManagedExternalSkillIntoTempWorkspace(descriptor, { env });
  try {
    if (!hasCompatibleManagedMetadata(metadata, descriptor)) {
      if (currentHash === latest.hash) {
        return {
          ...descriptor,
          state: "up_to_date",
          tracked: false,
          message: "Installed skill matches the latest source snapshot, but no compatible managed baseline metadata exists yet.",
        };
      }

      return {
        ...descriptor,
        state: "conflict",
        tracked: false,
        message: "Installed skill differs from the latest source snapshot, but no compatible managed baseline metadata exists to separate local edits from source changes.",
      };
    }

    if (currentHash === latest.hash) {
      return {
        ...descriptor,
        state: "up_to_date",
        tracked: true,
        message: "Installed skill matches the latest source snapshot.",
      };
    }

    if (currentHash === metadata.baselineHash) {
      return {
        ...descriptor,
        state: "update_available",
        tracked: true,
        message: "A newer source snapshot is available and local files are unchanged.",
      };
    }

    return {
      ...descriptor,
      state: "conflict",
      tracked: true,
      message:
        metadata.baselineHash === latest.hash
          ? "Local files differ from the managed baseline."
          : "Local files and source snapshot both differ from the managed baseline.",
    };
  } finally {
    rmSync(latest.tempRoot, { recursive: true, force: true });
  }
}

export function getManagedSkillStatus(
  env: NodeJS.ProcessEnv = process.env,
  names?: string[],
): ManagedSkillStatus[] {
  return resolveManagedSkillDescriptors(env, names)
    .map((descriptor) =>
      descriptor.sourceKind === "workspace-package" ? getWikiSkillStatus(descriptor) : getExternalManagedSkillStatus(descriptor, env),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}

function updateWikiManagedSkill(
  descriptor: ManagedSkillDescriptor,
  env: NodeJS.ProcessEnv = process.env,
  options: { force?: boolean } = {},
): ManagedSkillUpdateResult {
  const status = getWikiSkillStatus(descriptor);
  if (status.state === "conflict" && !options.force) {
    return {
      ...status,
      action: "skipped",
      message: `${status.message} Re-run with --force to replace it with the managed symlink.`,
    };
  }

  const paths = resolveRuntimePaths(env);
  const installed = ensureWikiSkillInstall(paths.wikiPath, paths.packageRoot);
  const nextStatus = getWikiSkillStatus(descriptor);
  return {
    ...nextStatus,
    action: status.state === "missing" ? "installed" : installed.status === "linked" ? "unchanged" : "updated",
  };
}

function updateExternalManagedSkill(
  descriptor: ManagedSkillDescriptor,
  env: NodeJS.ProcessEnv = process.env,
  options: { force?: boolean } = {},
): ManagedSkillUpdateResult {
  const currentStatus = getExternalManagedSkillStatus(descriptor, env);

  if (currentStatus.state === "missing") {
    installManagedExternalSkill(descriptor, { env });
    return {
      ...getExternalManagedSkillStatus(descriptor, env),
      action: "installed",
    };
  }

  if (currentStatus.state === "conflict" && !options.force) {
    return {
      ...currentStatus,
      action: "skipped",
      message: `${currentStatus.message} Refusing to overwrite local changes without --force.`,
    };
  }

  const latest = installManagedExternalSkillIntoTempWorkspace(descriptor, { env });
  try {
    const latestSkillPath = resolveWorkspaceSkillPath(latest.tempRoot, descriptor.name);
    const currentHash = hashSkillDirectory(descriptor.skillPath);
    const action: ManagedSkillUpdateAction = currentHash === latest.hash ? "unchanged" : "updated";

    if (action === "updated") {
      replaceSkillDirectory(descriptor.skillPath, latestSkillPath);
    }

    writeManagedSkillMetadata(
      descriptor.skillPath,
      createManagedSkillMetadata(descriptor, latest.hash, latest.invocation),
    );

    return {
      ...getExternalManagedSkillStatus(descriptor, env),
      action,
    };
  } finally {
    rmSync(latest.tempRoot, { recursive: true, force: true });
  }
}

export function updateManagedSkills(
  env: NodeJS.ProcessEnv = process.env,
  names?: string[],
  options: { force?: boolean } = {},
): ManagedSkillUpdateResult[] {
  return resolveManagedSkillDescriptors(env, names)
    .map((descriptor) =>
      descriptor.sourceKind === "workspace-package"
        ? updateWikiManagedSkill(descriptor, env, options)
        : updateExternalManagedSkill(descriptor, env, options),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function addManagedSkill(
  env: NodeJS.ProcessEnv = process.env,
  source: string,
  skillName: string,
  options: { force?: boolean } = {},
): ManagedSkillUpdateResult {
  const paths = resolveRuntimePaths(env);
  const workspace = resolveWorkspaceSkillPaths(paths.wikiPath);
  return updateExternalManagedSkill(
    createExternalDescriptor(workspace.workspaceRoot, skillName, source),
    env,
    options,
  );
}

export function ensureWikiSkillInstall(
  wikiPath: string,
  packageRoot: string,
): WikiSkillInstallResult {
  const paths = resolveWorkspaceSkillPaths(wikiPath);
  const packageRealPath = realpathSync(packageRoot);
  const existing = inspectSkillInstall(paths.wikiSkillPath, "tiangong-wiki-skill");

  ensureDirSync(paths.skillsRoot);

  if (existing.exists) {
    const stats = lstatSync(paths.wikiSkillPath);
    if (stats.isSymbolicLink()) {
      const currentRealPath = realpathSync(paths.wikiSkillPath);
      if (currentRealPath === packageRealPath) {
        return {
          sourcePath: packageRoot,
          skillPath: paths.wikiSkillPath,
          status: "linked",
        };
      }

      unlinkSync(paths.wikiSkillPath);
      linkWorkspaceSkill(packageRoot, paths.wikiSkillPath);
      return {
        sourcePath: packageRoot,
        skillPath: paths.wikiSkillPath,
        status: "updated",
      };
    }

    if (existing.readable) {
      rmSync(paths.wikiSkillPath, { recursive: true, force: true });
      linkWorkspaceSkill(packageRoot, paths.wikiSkillPath);
      return {
        sourcePath: packageRoot,
        skillPath: paths.wikiSkillPath,
        status: "updated",
      };
    }

    throw new AppError(
      `workspace skill path is occupied and cannot be reused: ${paths.wikiSkillPath}`,
      "config",
      {
        skillName: "tiangong-wiki-skill",
        skillPath: paths.wikiSkillPath,
      },
    );
  }

  linkWorkspaceSkill(packageRoot, paths.wikiSkillPath);
  return {
    sourcePath: packageRoot,
    skillPath: paths.wikiSkillPath,
    status: "linked",
  };
}

export function buildParserSkillInstallInvocation(skillName: ParserSkillName): {
  command: string;
  args: string[];
  rendered: string;
} {
  return buildExternalSkillInstallInvocation(PARSER_SKILL_SOURCE, skillName);
}

export function installParserSkill(
  skillName: ParserSkillName,
  workspaceRoot: string,
  options: {
    env?: NodeJS.ProcessEnv;
    output?: NodeJS.WritableStream;
  } = {},
): ParserSkillInstallResult {
  const installed = installManagedExternalSkill(
    createParserDescriptor(workspaceRoot, skillName, true),
    {
      env: options.env,
      output: options.output,
    },
  );

  return {
    name: skillName,
    skillPath: installed.skillPath,
    skillMdPath: installed.skillMdPath,
    status: installed.status,
    command: installed.command,
  };
}
