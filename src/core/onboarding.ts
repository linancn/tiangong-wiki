import { accessSync, constants, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { confirm, input, password, select } from "@inquirer/prompts";

import { DEFAULT_WIKI_ENV_FILE, getCliEnvironmentInfo, parseEnvFile, serializeEnvEntries } from "./cli-env.js";
import { resolveTemplateFilePath, loadConfig } from "./config.js";
import { EmbeddingClient } from "./embedding.js";
import { writeGlobalConfig } from "./global-config.js";
import { parseVaultHashMode, parseWikiAgentSandboxMode, resolveAgentSettings } from "./paths.js";
import { loadSynologyConfigFromEnv, normalizeSynologyRemotePath, withSynologyClient } from "./synology.js";
import {
  ensureWikiSkillInstall,
  formatParserSkills,
  inspectSkillInstall,
  installParserSkill,
  OPTIONAL_PARSER_SKILLS,
  parseParserSkillSelection,
  parseParserSkills,
  resolveWorkspaceRootFromWikiPath,
  resolveWorkspaceSkillPath,
  resolveWorkspaceSkillPaths,
  type ParserSkillName,
} from "./workspace-skills.js";
import { scaffoldWorkspaceAssets } from "./workspace-bootstrap.js";
import { AppError } from "../utils/errors.js";
import { pathExistsSync, writeTextFileSync } from "../utils/fs.js";

export type DoctorSeverity = "ok" | "warn" | "error";
type VaultSource = "local" | "synology";

export interface DoctorCheck {
  id: string;
  severity: DoctorSeverity;
  summary: string;
  recommendation?: string;
}

export interface DoctorReport {
  ok: boolean;
  summary: {
    ok: number;
    warn: number;
    error: number;
  };
  envFile: {
    requestedPath: string | null;
    loadedPath: string | null;
    autoDiscovered: boolean;
    missingRequestedPath: boolean;
    missingDefaultPath: boolean;
    source: string;
    globalConfigPath: string | null;
    defaultPath: string | null;
  };
  effectivePaths: {
    wikiPath: string | null;
    workspaceRoot: string | null;
    vaultPath: string | null;
    dbPath: string | null;
    configPath: string | null;
    templatesPath: string | null;
    skillsRoot: string | null;
  };
  skills: {
    requestedParserSkills: ParserSkillName[];
    invalidParserSkills: string[];
    missingSkills: string[];
  };
  checks: DoctorCheck[];
  recommendations: string[];
}

interface SetupValues {
  envFilePath: string;
  vaultSource: VaultSource;
  wikiPath: string;
  vaultPath: string;
  vaultHashMode: "content" | "mtime";
  synologyBaseUrl: string | null;
  synologyUsername: string | null;
  synologyPassword: string | null;
  synologyRemotePath: string | null;
  synologyVerifySsl: boolean;
  synologyReadonly: boolean;
  dbPath: string;
  configPath: string;
  templatesPath: string;
  syncInterval: string;
  embeddingEnabled: boolean;
  embeddingBaseUrl: string | null;
  embeddingApiKey: string | null;
  embeddingModel: string | null;
  embeddingDimensions: string | null;
  agentEnabled: boolean;
  agentBaseUrl: string | null;
  agentApiKey: string | null;
  agentModel: string | null;
  agentBatchSize: string | null;
  agentSandboxMode: "danger-full-access" | "workspace-write" | null;
  parserSkills: ParserSkillName[];
}

export interface SetupResult {
  envFilePath: string;
  globalConfigPath: string;
  createdDirectories: string[];
  copiedConfig: boolean;
  copiedTemplates: number;
  embeddingEnabled: boolean;
  agentEnabled: boolean;
  parserSkills: ParserSkillName[];
  skillsRoot: string;
}

interface PromptContext {
  cwd: string;
  output: NodeJS.WritableStream;
}

interface PromptChoice<Value extends string> {
  value: Value;
  label: string;
  description?: string;
}

interface TextPromptOptions {
  message: string;
  defaultValue?: string;
  required?: boolean;
  validator?: (value: string) => string | null;
}

interface ConfirmPromptOptions {
  message: string;
  defaultValue: boolean;
}

interface SelectPromptOptions<Value extends string> {
  message: string;
  defaultValue: Value;
  choices: PromptChoice<Value>[];
}

interface PromptDriver {
  input(options: TextPromptOptions): Promise<string>;
  password(options: TextPromptOptions): Promise<string>;
  confirm(options: ConfirmPromptOptions): Promise<boolean>;
  select<Value extends string>(options: SelectPromptOptions<Value>): Promise<Value>;
  close(): void;
}

const MANAGED_ENV_KEYS = new Set([
  "WIKI_PATH",
  "VAULT_PATH",
  "VAULT_SOURCE",
  "VAULT_HASH_MODE",
  "VAULT_SYNOLOGY_REMOTE_PATH",
  "WIKI_DB_PATH",
  "WIKI_CONFIG_PATH",
  "WIKI_TEMPLATES_PATH",
  "WIKI_SYNC_INTERVAL",
  "SYNOLOGY_BASE_URL",
  "SYNOLOGY_USERNAME",
  "SYNOLOGY_PASSWORD",
  "SYNOLOGY_VERIFY_SSL",
  "SYNOLOGY_READONLY",
  "EMBEDDING_BASE_URL",
  "EMBEDDING_API_KEY",
  "EMBEDDING_MODEL",
  "EMBEDDING_DIMENSIONS",
  "WIKI_AGENT_ENABLED",
  "WIKI_AGENT_BASE_URL",
  "WIKI_AGENT_API_KEY",
  "WIKI_AGENT_MODEL",
  "WIKI_AGENT_BATCH_SIZE",
  "WIKI_AGENT_SANDBOX_MODE",
  "WIKI_PARSER_SKILLS",
]);

function writeSection(output: NodeJS.WritableStream, title: string): void {
  output.write(`\n${title}\n`);
}

function writeWarning(output: NodeJS.WritableStream, message: string): void {
  const isTty = "isTTY" in output && output.isTTY;
  output.write(isTty ? `\x1b[31m${message}\x1b[0m\n` : `${message}\n`);
}

function resolvePackageRoot(packageRoot?: string): string {
  return packageRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function resolveInputPath(value: string, cwd: string): string {
  return path.resolve(cwd, value.trim());
}

function normalizeVaultSource(rawValue: string | undefined): VaultSource {
  const normalized = (rawValue ?? "local").trim().toLowerCase();
  if (!normalized || normalized === "local") {
    return "local";
  }
  if (normalized === "synology") {
    return "synology";
  }
  throw new AppError(`VAULT_SOURCE must be "local" or "synology", got ${rawValue}`, "config");
}

function safeVaultSource(rawValue: string | undefined): VaultSource {
  try {
    return normalizeVaultSource(rawValue);
  } catch {
    return "local";
  }
}

function safeVaultHashMode(rawValue: string | undefined, defaultValue: "content" | "mtime"): "content" | "mtime" {
  try {
    return parseVaultHashMode(rawValue);
  } catch {
    return defaultValue;
  }
}

function safeAgentSandboxMode(rawValue: string | undefined): "danger-full-access" | "workspace-write" {
  try {
    return parseWikiAgentSandboxMode(rawValue);
  } catch {
    return "danger-full-access";
  }
}

function safeBooleanFlag(rawValue: string | undefined, defaultValue: boolean): boolean {
  if (rawValue === undefined || rawValue.trim().length === 0) {
    return defaultValue;
  }
  const normalized = rawValue.trim().toLowerCase();
  if (["1", "true", "yes", "on", "y"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off", "n"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function validateNonNegativeInteger(rawValue: string, label: string): string | null {
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return `${label} must be a non-negative integer.`;
  }

  return null;
}

function validateUrl(rawValue: string, label: string): string | null {
  const value = rawValue.trim();
  if (!/^https?:\/\//i.test(value)) {
    return `${label} must start with http:// or https://.`;
  }

  return null;
}

function validateWikiPath(rawValue: string): string | null {
  const normalized = rawValue.replace(/[\\/]+$/g, "");
  if (!normalized.endsWith("/pages") && !normalized.endsWith("\\pages")) {
    return "WIKI_PATH must point to the wiki/pages directory.";
  }

  return null;
}

class InquirerPromptDriver implements PromptDriver {
  constructor(
    private readonly inputStream: NodeJS.ReadableStream,
    private readonly outputStream: NodeJS.WritableStream,
  ) {}

  input(options: TextPromptOptions): Promise<string> {
    return input(
      {
        message: options.message,
        default: options.defaultValue,
        required: options.required !== false,
        validate: (value) => options.validator?.(value) ?? true,
      },
      this.getContext(),
    );
  }

  password(options: TextPromptOptions): Promise<string> {
    const defaultValue = options.defaultValue ?? "";
    const hasDefault = defaultValue.length > 0;

    return password(
      {
        message: hasDefault ? `${options.message} (press enter to keep current value)` : options.message,
        mask: "*",
        validate: (value) => {
          const candidate = value.length === 0 && hasDefault ? defaultValue : value;
          if (options.required !== false && candidate.length === 0) {
            return `${options.message} is required.`;
          }
          return options.validator?.(candidate) ?? true;
        },
      },
      this.getContext(),
    ).then((value) => (value.length === 0 && hasDefault ? defaultValue : value));
  }

  confirm(options: ConfirmPromptOptions): Promise<boolean> {
    return confirm(
      {
        message: options.message,
        default: options.defaultValue,
      },
      this.getContext(),
    );
  }

  select<Value extends string>(options: SelectPromptOptions<Value>): Promise<Value> {
    return select(
      {
        message: options.message,
        default: options.defaultValue,
        choices: options.choices.map((choice) => ({
          value: choice.value,
          name: choice.label,
          description: choice.description,
        })),
      },
      this.getContext(),
    );
  }

  private getContext() {
    return {
      input: this.inputStream,
      output: this.outputStream,
      clearPromptOnDone: false,
    };
  }

  close(): void {
    // Inquirer manages prompt lifecycle; no explicit teardown needed here.
  }
}

class BufferedPromptDriver implements PromptDriver {
  private index = 0;

  constructor(
    private readonly answers: string[],
    private readonly output: NodeJS.WritableStream,
  ) {}

  async input(options: TextPromptOptions): Promise<string> {
    const defaultValue = options.defaultValue ?? "";
    const label = formatBufferedPromptLabel(options.message, defaultValue);

    while (true) {
      const answer = this.readAnswer(label);
      const candidate = (answer.trim() || defaultValue).trim();
      if (options.required !== false && candidate.length === 0) {
        this.output.write(`${options.message} is required.\n`);
        continue;
      }

      const error = options.validator?.(candidate);
      if (error) {
        this.output.write(`${error}\n`);
        continue;
      }

      return candidate;
    }
  }

  async password(options: TextPromptOptions): Promise<string> {
    const defaultValue = options.defaultValue ?? "";
    const label = formatBufferedPromptLabel(options.message, defaultValue, {
      defaultDisplay: defaultValue.length > 0 ? "(saved)" : "",
    });

    while (true) {
      const answer = this.readAnswer(label);
      const candidate = answer.length === 0 ? defaultValue : answer;
      if (options.required !== false && candidate.length === 0) {
        this.output.write(`${options.message} is required.\n`);
        continue;
      }

      const error = options.validator?.(candidate);
      if (error) {
        this.output.write(`${error}\n`);
        continue;
      }

      return candidate;
    }
  }

  async confirm(options: ConfirmPromptOptions): Promise<boolean> {
    const suffix = options.defaultValue ? "Y/n" : "y/N";

    while (true) {
      const answer = this.readAnswer(`${options.message} [${suffix}]: `).trim().toLowerCase();
      if (!answer) {
        return options.defaultValue;
      }
      if (["y", "yes"].includes(answer)) {
        return true;
      }
      if (["n", "no"].includes(answer)) {
        return false;
      }
      this.output.write("Please answer yes or no.\n");
    }
  }

  async select<Value extends string>(options: SelectPromptOptions<Value>): Promise<Value> {
    const choiceList = options.choices.map((choice) => choice.value).join("/");

    while (true) {
      const answer = this.readAnswer(`${options.message} [${choiceList}] (${options.defaultValue}): `).trim().toLowerCase();
      if (!answer) {
        return options.defaultValue;
      }

      const match = options.choices.find((choice) => {
        return choice.value.toLowerCase() === answer || choice.label.trim().toLowerCase() === answer;
      });
      if (match) {
        return match.value;
      }

      this.output.write(`Please choose one of: ${choiceList}.\n`);
    }
  }

  close(): void {}

  private readAnswer(prompt: string): string {
    const answer = this.answers[this.index] ?? "";
    this.index += 1;
    this.output.write(`${prompt}${answer}\n`);
    return answer;
  }
}

function formatBufferedPromptLabel(
  message: string,
  defaultValue: string,
  options: { defaultDisplay?: string } = {},
): string {
  const display = options.defaultDisplay ?? defaultValue;
  return display ? `${message} [${display}]: ` : `${message}: `;
}

async function readBufferedAnswers(input: NodeJS.ReadableStream): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) {
    return [];
  }

  return raw.split(/\r?\n/);
}

async function createPromptDriver(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<PromptDriver> {
  if ("isTTY" in input && input.isTTY) {
    return new InquirerPromptDriver(input, output);
  }

  return new BufferedPromptDriver(await readBufferedAnswers(input), output);
}

async function promptText(
  driver: PromptDriver,
  label: string,
  defaultValue: string,
  options: {
    required?: boolean;
    validator?: (value: string) => string | null;
    normalize?: (value: string) => string;
  } = {},
): Promise<string> {
  const candidate = await driver.input({
    message: label,
    defaultValue,
    required: options.required,
    validator: options.validator,
  });
  return options.normalize ? options.normalize(candidate) : candidate;
}

async function promptPassword(
  driver: PromptDriver,
  label: string,
  defaultValue: string,
  options: {
    required?: boolean;
    validator?: (value: string) => string | null;
    normalize?: (value: string) => string;
  } = {},
): Promise<string> {
  const candidate = await driver.password({
    message: label,
    defaultValue,
    required: options.required,
    validator: options.validator,
  });
  return options.normalize ? options.normalize(candidate) : candidate;
}

async function promptYesNo(
  driver: PromptDriver,
  label: string,
  defaultValue: boolean,
): Promise<boolean> {
  return driver.confirm({
    message: label,
    defaultValue,
  });
}

function formatStep(index: number, total: number, title: string): string {
  return `Step ${index}/${total}: ${title}`;
}

async function promptVaultSource(
  driver: PromptDriver,
  defaultValue: VaultSource,
): Promise<VaultSource> {
  return driver.select({
    message: "VAULT_SOURCE",
    defaultValue,
    choices: [
      {
        value: "local",
        label: "local",
        description: "Read the vault directly from the local filesystem.",
      },
      {
        value: "synology",
        label: "synology",
        description: "Download the vault from Synology NAS into a local cache.",
      },
    ],
  });
}

async function promptVaultHashMode(
  driver: PromptDriver,
  defaultValue: "content" | "mtime",
): Promise<"content" | "mtime"> {
  return driver.select({
    message: "VAULT_HASH_MODE",
    defaultValue,
    choices: [
      {
        value: "content",
        label: "content",
        description: "Hash file content to detect changes.",
      },
      {
        value: "mtime",
        label: "mtime",
        description: "Use modification time, recommended for remote Synology sync.",
      },
    ],
  });
}

function canReadWrite(targetPath: string): boolean {
  accessSync(targetPath, constants.R_OK | constants.W_OK);
  return true;
}

function canWrite(targetPath: string): boolean {
  accessSync(targetPath, constants.W_OK);
  return true;
}

function collectDoctorCheck(
  checks: DoctorCheck[],
  severity: DoctorSeverity,
  id: string,
  summary: string,
  recommendation?: string,
): void {
  checks.push({ id, severity, summary, ...(recommendation ? { recommendation } : {}) });
}

function getPathDefaults(env: NodeJS.ProcessEnv, cwd: string): SetupValues {
  const vaultSource = safeVaultSource(env.VAULT_SOURCE);
  const wikiRoot = env.WIKI_PATH ? path.resolve(env.WIKI_PATH, "..") : path.join(cwd, "tiangong-wiki");
  const wikiPath = env.WIKI_PATH ? path.resolve(env.WIKI_PATH) : path.join(wikiRoot, "pages");
  const vaultPath = env.VAULT_PATH ? path.resolve(env.VAULT_PATH) : path.join(cwd, "vault");
  const dbPath = env.WIKI_DB_PATH ? path.resolve(env.WIKI_DB_PATH) : path.join(wikiRoot, "index.db");
  const configPath = env.WIKI_CONFIG_PATH ? path.resolve(env.WIKI_CONFIG_PATH) : path.join(wikiRoot, "wiki.config.json");
  const templatesPath = env.WIKI_TEMPLATES_PATH ? path.resolve(env.WIKI_TEMPLATES_PATH) : path.join(wikiRoot, "templates");
  const defaultHashMode = vaultSource === "synology" ? "mtime" : "content";

  return {
    envFilePath: env.WIKI_ENV_FILE ? path.resolve(cwd, env.WIKI_ENV_FILE) : path.join(cwd, DEFAULT_WIKI_ENV_FILE),
    vaultSource,
    wikiPath,
    vaultPath,
    vaultHashMode: safeVaultHashMode(env.VAULT_HASH_MODE, defaultHashMode),
    synologyBaseUrl: env.SYNOLOGY_BASE_URL ?? env.SYNOLOGY_URL ?? null,
    synologyUsername: env.SYNOLOGY_USERNAME ?? env.SYNOLOGY_USER ?? null,
    synologyPassword: env.SYNOLOGY_PASSWORD ?? env.SYNOLOGY_PASS ?? null,
    synologyRemotePath: env.VAULT_SYNOLOGY_REMOTE_PATH ?? null,
    synologyVerifySsl: safeBooleanFlag(env.SYNOLOGY_VERIFY_SSL, true),
    synologyReadonly: safeBooleanFlag(env.SYNOLOGY_READONLY, true),
    dbPath,
    configPath,
    templatesPath,
    syncInterval: env.WIKI_SYNC_INTERVAL ?? "86400",
    embeddingEnabled: Boolean((env.EMBEDDING_BASE_URL ?? env.OPENROUTER_BASE_URL) && (env.EMBEDDING_API_KEY ?? env.OPENROUTER_API_KEY) && (env.EMBEDDING_MODEL ?? env.OPENROUTER_EMBEDDING_MODEL)),
    embeddingBaseUrl: env.EMBEDDING_BASE_URL ?? env.OPENROUTER_BASE_URL ?? "https://api.openai.com/v1",
    embeddingApiKey: env.EMBEDDING_API_KEY ?? env.OPENROUTER_API_KEY ?? null,
    embeddingModel: env.EMBEDDING_MODEL ?? env.OPENROUTER_EMBEDDING_MODEL ?? "text-embedding-3-small",
    embeddingDimensions: env.EMBEDDING_DIMENSIONS ?? "384",
    agentEnabled: (env.WIKI_AGENT_ENABLED ?? "").trim().toLowerCase() === "true",
    agentBaseUrl: env.WIKI_AGENT_BASE_URL ?? "https://api.openai.com/v1",
    agentApiKey: env.WIKI_AGENT_API_KEY ?? null,
    agentModel: env.WIKI_AGENT_MODEL ?? null,
    agentBatchSize: env.WIKI_AGENT_BATCH_SIZE ?? "5",
    agentSandboxMode: safeAgentSandboxMode(env.WIKI_AGENT_SANDBOX_MODE),
    parserSkills: parseParserSkills(env.WIKI_PARSER_SKILLS, { strict: false }),
  };
}

async function collectEmbeddingSettings(
  driver: PromptDriver,
  ctx: PromptContext,
  defaults: SetupValues,
  env: NodeJS.ProcessEnv,
): Promise<Pick<SetupValues, "embeddingEnabled" | "embeddingBaseUrl" | "embeddingApiKey" | "embeddingModel" | "embeddingDimensions">> {
  const enabled = await promptYesNo(driver, "Enable semantic search with embeddings?", defaults.embeddingEnabled);
  if (!enabled) {
    return {
      embeddingEnabled: false,
      embeddingBaseUrl: null,
      embeddingApiKey: null,
      embeddingModel: null,
      embeddingDimensions: null,
    };
  }

  while (true) {
    const embeddingBaseUrl = await promptText(driver, "EMBEDDING_BASE_URL", defaults.embeddingBaseUrl ?? "https://api.openai.com/v1", {
      validator: (value) => validateUrl(value, "EMBEDDING_BASE_URL"),
    });
    const embeddingApiKey = await promptPassword(driver, "EMBEDDING_API_KEY", defaults.embeddingApiKey ?? "", {
      required: true,
    });
    const embeddingModel = await promptText(
      driver,
      "EMBEDDING_MODEL",
      defaults.embeddingModel ?? "text-embedding-3-small",
      { required: true },
    );
    const embeddingDimensions = await promptText(
      driver,
      "EMBEDDING_DIMENSIONS",
      defaults.embeddingDimensions ?? "384",
      { validator: (value) => validateNonNegativeInteger(value, "EMBEDDING_DIMENSIONS") },
    );

    const shouldProbe = await promptYesNo(driver, "Probe the embedding endpoint now?", false);
    if (shouldProbe) {
      try {
        const probeEnv = {
          ...env,
          EMBEDDING_BASE_URL: embeddingBaseUrl,
          EMBEDDING_API_KEY: embeddingApiKey,
          EMBEDDING_MODEL: embeddingModel,
          EMBEDDING_DIMENSIONS: embeddingDimensions,
        };
        const client = EmbeddingClient.fromEnv(probeEnv);
        if (!client) {
          throw new AppError("Embedding configuration is incomplete.", "config");
        }
        await client.probe();
        ctx.output.write("Embedding probe succeeded.\n");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.output.write(`Embedding probe failed: ${message}\n`);
        if (await promptYesNo(driver, "Re-enter embedding settings?", true)) {
          continue;
        }
      }
    }

    return {
      embeddingEnabled: true,
      embeddingBaseUrl,
      embeddingApiKey,
      embeddingModel,
      embeddingDimensions,
    };
  }
}

async function collectAgentSettings(
  driver: PromptDriver,
  ctx: PromptContext,
  defaults: SetupValues,
): Promise<
  Pick<SetupValues, "agentEnabled" | "agentBaseUrl" | "agentApiKey" | "agentModel" | "agentBatchSize" | "agentSandboxMode">
> {
  const enabled = await promptYesNo(
    driver,
    "Enable automatic vault-to-wiki processing?",
    defaults.agentEnabled,
  );
  if (!enabled) {
    return {
      agentEnabled: false,
      agentBaseUrl: null,
      agentApiKey: null,
      agentModel: null,
      agentBatchSize: null,
      agentSandboxMode: null,
    };
  }

  writeWarning(ctx.output, "Warning: danger-full-access grants full access to the runtime workspace.");

  return {
    agentEnabled: true,
    agentBaseUrl: await promptText(
      driver,
      "WIKI_AGENT_BASE_URL",
      defaults.agentBaseUrl ?? "https://api.openai.com/v1",
      { validator: (value) => validateUrl(value, "WIKI_AGENT_BASE_URL") },
    ),
    agentApiKey: await promptPassword(driver, "WIKI_AGENT_API_KEY", defaults.agentApiKey ?? "", { required: true }),
    agentModel: await promptText(
      driver,
      "WIKI_AGENT_MODEL",
      defaults.agentModel ?? "",
      { required: true },
    ),
    agentBatchSize: await promptText(
      driver,
      "WIKI_AGENT_BATCH_SIZE",
      defaults.agentBatchSize ?? "5",
      { validator: (value) => validateNonNegativeInteger(value, "WIKI_AGENT_BATCH_SIZE") },
    ),
    agentSandboxMode: await driver.select<"danger-full-access" | "workspace-write">({
      message: "WIKI_AGENT_SANDBOX_MODE",
      defaultValue: defaults.agentSandboxMode ?? "danger-full-access",
      choices: [
        {
          value: "danger-full-access",
          label: "danger-full-access",
          description: "Full access to the runtime workspace. Default.",
        },
        {
          value: "workspace-write",
          label: "workspace-write",
          description: "Use Codex workspace-write sandbox when the host supports it.",
        },
      ],
    }),
  };
}

async function collectSynologySettings(
  driver: PromptDriver,
  ctx: PromptContext,
  defaults: SetupValues,
): Promise<Pick<
  SetupValues,
  "vaultHashMode" | "synologyBaseUrl" | "synologyUsername" | "synologyPassword" | "synologyRemotePath" | "synologyVerifySsl" | "synologyReadonly"
>> {
  const synologyBaseUrl = await promptText(
    driver,
    "SYNOLOGY_BASE_URL",
    defaults.synologyBaseUrl ?? "https://nas.example.com:5001",
    { validator: (value) => validateUrl(value, "SYNOLOGY_BASE_URL") },
  );
  const synologyUsername = await promptText(
    driver,
    "SYNOLOGY_USERNAME",
    defaults.synologyUsername ?? "",
    { required: true },
  );
  const synologyPassword = await promptPassword(driver, "SYNOLOGY_PASSWORD", defaults.synologyPassword ?? "", {
    required: true,
  });
  const synologyRemotePath = await promptText(
    driver,
    "VAULT_SYNOLOGY_REMOTE_PATH",
    defaults.synologyRemotePath ?? "/homes/user/wiki-vault",
    {
      validator: (value) => {
        try {
          normalizeSynologyRemotePath(value);
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
      normalize: (value) => normalizeSynologyRemotePath(value),
    },
  );
  const vaultHashMode = await promptVaultHashMode(driver, "mtime");
  const synologyVerifySsl = await promptYesNo(driver, "SYNOLOGY_VERIFY_SSL", defaults.synologyVerifySsl);
  const synologyReadonly = await promptYesNo(driver, "SYNOLOGY_READONLY", defaults.synologyReadonly);

  return {
    vaultHashMode,
    synologyBaseUrl,
    synologyUsername,
    synologyPassword,
    synologyRemotePath,
    synologyVerifySsl,
    synologyReadonly,
  };
}

async function collectParserSkillSettings(
  driver: PromptDriver,
  ctx: PromptContext,
  defaults: SetupValues,
  wikiPath: string,
): Promise<ParserSkillName[]> {
  const { skillsRoot } = resolveWorkspaceSkillPaths(wikiPath);
  ctx.output.write(`tiangong-wiki-skill is required and will be installed at ${path.join(skillsRoot, "tiangong-wiki-skill")}.\n`);

  const selected = new Set<ParserSkillName>(defaults.parserSkills);
  for (const skill of OPTIONAL_PARSER_SKILLS) {
    const enabled = await promptYesNo(
      driver,
      `Install parser skill ${skill.name} (${skill.summary})?`,
      selected.has(skill.name),
    );
    if (enabled) {
      selected.add(skill.name);
    } else {
      selected.delete(skill.name);
    }
  }

  return OPTIONAL_PARSER_SKILLS.map((skill) => skill.name).filter((skill) => selected.has(skill));
}

function buildSetupSummary(values: SetupValues): string {
  const { workspaceRoot, skillsRoot } = resolveWorkspaceSkillPaths(values.wikiPath);
  const lines = [
    "Configuration summary",
    `  WIKI_ENV_FILE: ${values.envFilePath}`,
    `  WORKSPACE_ROOT: ${workspaceRoot}`,
    `  VAULT_SOURCE: ${values.vaultSource}`,
    `  WIKI_PATH: ${values.wikiPath}`,
    `  VAULT_PATH: ${values.vaultPath}${values.vaultSource === "synology" ? " (local cache)" : ""}`,
    `  VAULT_HASH_MODE: ${values.vaultHashMode}`,
    `  WIKI_DB_PATH: ${values.dbPath}`,
    `  WIKI_CONFIG_PATH: ${values.configPath}`,
    `  WIKI_TEMPLATES_PATH: ${values.templatesPath}`,
    `  WIKI_SYNC_INTERVAL: ${values.syncInterval}`,
    `  Embeddings: ${values.embeddingEnabled ? "enabled" : "disabled"}`,
    `  Vault processing: ${values.agentEnabled ? "enabled" : "disabled"}`,
    `  Skills root: ${skillsRoot}`,
    `  Required skill: tiangong-wiki-skill`,
    `  Parser skills: ${values.parserSkills.length > 0 ? values.parserSkills.join(", ") : "(none)"}`,
  ];

  if (values.embeddingEnabled) {
    lines.push(`  EMBEDDING_BASE_URL: ${values.embeddingBaseUrl}`);
    lines.push(`  EMBEDDING_MODEL: ${values.embeddingModel}`);
    lines.push(`  EMBEDDING_DIMENSIONS: ${values.embeddingDimensions}`);
  }

  if (values.agentEnabled) {
    lines.push(`  WIKI_AGENT_BASE_URL: ${values.agentBaseUrl}`);
    lines.push(`  WIKI_AGENT_MODEL: ${values.agentModel}`);
    lines.push(`  WIKI_AGENT_BATCH_SIZE: ${values.agentBatchSize}`);
    lines.push(`  WIKI_AGENT_SANDBOX_MODE: ${values.agentSandboxMode}`);
  }

  if (values.vaultSource === "synology") {
    lines.push(`  SYNOLOGY_BASE_URL: ${values.synologyBaseUrl}`);
    lines.push(`  SYNOLOGY_USERNAME: ${values.synologyUsername}`);
    lines.push(`  VAULT_SYNOLOGY_REMOTE_PATH: ${values.synologyRemotePath}`);
    lines.push(`  SYNOLOGY_VERIFY_SSL: ${values.synologyVerifySsl ? "true" : "false"}`);
    lines.push(`  SYNOLOGY_READONLY: ${values.synologyReadonly ? "true" : "false"}`);
  }

  return lines.join("\n");
}

function writeSetupEnvFile(values: SetupValues): void {
  const existingEntries =
    pathExistsSync(values.envFilePath) ? parseEnvFile(readFileSync(values.envFilePath, "utf8")) : {};
  const preservedEntries = Object.entries(existingEntries).filter(([key]) => !MANAGED_ENV_KEYS.has(key));

  const managedEntries: Array<[string, string | null | undefined]> = [
    ["WIKI_PATH", values.wikiPath],
    ["VAULT_PATH", values.vaultPath],
    ["VAULT_SOURCE", values.vaultSource],
    ["VAULT_HASH_MODE", values.vaultHashMode],
    ["VAULT_SYNOLOGY_REMOTE_PATH", values.vaultSource === "synology" ? values.synologyRemotePath : null],
    ["WIKI_DB_PATH", values.dbPath],
    ["WIKI_CONFIG_PATH", values.configPath],
    ["WIKI_TEMPLATES_PATH", values.templatesPath],
    ["WIKI_SYNC_INTERVAL", values.syncInterval],
    ["SYNOLOGY_BASE_URL", values.vaultSource === "synology" ? values.synologyBaseUrl : null],
    ["SYNOLOGY_USERNAME", values.vaultSource === "synology" ? values.synologyUsername : null],
    ["SYNOLOGY_PASSWORD", values.vaultSource === "synology" ? values.synologyPassword : null],
    ["SYNOLOGY_VERIFY_SSL", values.vaultSource === "synology" ? String(values.synologyVerifySsl) : null],
    ["SYNOLOGY_READONLY", values.vaultSource === "synology" ? String(values.synologyReadonly) : null],
    ["EMBEDDING_BASE_URL", values.embeddingEnabled ? values.embeddingBaseUrl : null],
    ["EMBEDDING_API_KEY", values.embeddingEnabled ? values.embeddingApiKey : null],
    ["EMBEDDING_MODEL", values.embeddingEnabled ? values.embeddingModel : null],
    ["EMBEDDING_DIMENSIONS", values.embeddingEnabled ? values.embeddingDimensions : null],
    ["WIKI_AGENT_ENABLED", values.agentEnabled ? "true" : "false"],
    ["WIKI_AGENT_BASE_URL", values.agentEnabled ? values.agentBaseUrl : null],
    ["WIKI_AGENT_API_KEY", values.agentEnabled ? values.agentApiKey : null],
    ["WIKI_AGENT_MODEL", values.agentEnabled ? values.agentModel : null],
    ["WIKI_AGENT_BATCH_SIZE", values.agentEnabled ? values.agentBatchSize : null],
    ["WIKI_AGENT_SANDBOX_MODE", values.agentEnabled ? values.agentSandboxMode : null],
    ["WIKI_PARSER_SKILLS", formatParserSkills(values.parserSkills)],
  ];

  const body = [
    "# Generated by `tiangong-wiki setup`.",
    "# You can edit this file manually and rerun `tiangong-wiki doctor` to validate changes.",
    "",
    serializeEnvEntries([...managedEntries, ...preservedEntries]),
  ].join("\n");

  writeTextFileSync(values.envFilePath, body);
}

export async function runSetupWizard(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    cwd?: string;
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
    packageRoot?: string;
  } = {},
): Promise<SetupResult> {
  const cwd = options.cwd ?? process.cwd();
  const output = options.output ?? process.stdout;
  const defaults = getPathDefaults(env, cwd);
  const driver = await createPromptDriver(options.input ?? process.stdin, output);
  const ctx: PromptContext = { cwd, output };

  try {
    writeSection(output, "Step 1: Configuration file");
    const envFilePath = await promptText(driver, "Path for the generated .wiki.env file", defaults.envFilePath, {
      normalize: (value) => resolveInputPath(value, cwd),
    });

    writeSection(output, "Step 2: Vault source");
    const vaultSource = await promptVaultSource(driver, defaults.vaultSource);
    const totalSteps = vaultSource === "synology" ? 9 : 8;

    writeSection(output, formatStep(3, totalSteps, "Core paths"));
    const wikiPath = await promptText(driver, "WIKI_PATH", defaults.wikiPath, {
      normalize: (value) => resolveInputPath(value, cwd),
      validator: (value) => validateWikiPath(resolveInputPath(value, cwd)),
    });
    const vaultPath = await promptText(
      driver,
      vaultSource === "synology" ? "VAULT_PATH (local cache directory)" : "VAULT_PATH",
      defaults.vaultPath,
      {
        normalize: (value) => resolveInputPath(value, cwd),
      },
    );
    const dbPath = await promptText(driver, "WIKI_DB_PATH", defaults.dbPath, {
      normalize: (value) => resolveInputPath(value, cwd),
    });
    const configPath = await promptText(driver, "WIKI_CONFIG_PATH", defaults.configPath, {
      normalize: (value) => resolveInputPath(value, cwd),
    });
    const templatesPath = await promptText(driver, "WIKI_TEMPLATES_PATH", defaults.templatesPath, {
      normalize: (value) => resolveInputPath(value, cwd),
    });

    let synologyValues: Pick<
      SetupValues,
      "vaultHashMode" | "synologyBaseUrl" | "synologyUsername" | "synologyPassword" | "synologyRemotePath" | "synologyVerifySsl" | "synologyReadonly"
    >;
    if (vaultSource === "synology") {
      writeSection(output, formatStep(4, totalSteps, "Synology NAS"));
      output.write("Synology mode uses VAULT_PATH as the local cache directory for downloaded vault files.\n");
      synologyValues = await collectSynologySettings(driver, ctx, defaults);
    } else {
      synologyValues = {
        vaultHashMode: defaults.vaultSource === "local" ? defaults.vaultHashMode : "content",
        synologyBaseUrl: null,
        synologyUsername: null,
        synologyPassword: null,
        synologyRemotePath: null,
        synologyVerifySsl: defaults.synologyVerifySsl,
        synologyReadonly: defaults.synologyReadonly,
      };
    }

    writeSection(output, formatStep(vaultSource === "synology" ? 5 : 4, totalSteps, "Sync schedule"));
    const syncInterval = await promptText(driver, "WIKI_SYNC_INTERVAL (seconds)", defaults.syncInterval, {
      validator: (value) => validateNonNegativeInteger(value, "WIKI_SYNC_INTERVAL"),
    });

    writeSection(output, formatStep(vaultSource === "synology" ? 6 : 5, totalSteps, "Embedding configuration"));
    const embedding = await collectEmbeddingSettings(driver, ctx, defaults, env);

    writeSection(output, formatStep(vaultSource === "synology" ? 7 : 6, totalSteps, "Automatic vault processing"));
    const agent = await collectAgentSettings(driver, ctx, defaults);

    writeSection(output, formatStep(vaultSource === "synology" ? 8 : 7, totalSteps, "Codex skills"));
    const parserSkills = await collectParserSkillSettings(driver, ctx, defaults, wikiPath);

    const values: SetupValues = {
      envFilePath,
      vaultSource,
      wikiPath,
      vaultPath,
      ...synologyValues,
      dbPath,
      configPath,
      templatesPath,
      syncInterval,
      ...embedding,
      ...agent,
      parserSkills,
    };

    writeSection(output, formatStep(totalSteps, totalSteps, "Confirm"));
    output.write(`${buildSetupSummary(values)}\n`);
    const confirmed = await promptYesNo(driver, "Write configuration and scaffold workspace assets?", true);
    if (!confirmed) {
      throw new AppError("Setup aborted before writing any files.", "runtime");
    }

    const packageRoot = resolvePackageRoot(options.packageRoot);
    const bootstrap = scaffoldWorkspaceAssets({
      packageRoot,
      wikiRoot: path.resolve(wikiPath, ".."),
      wikiPath,
      vaultPath,
      templatesPath,
      configPath,
    });
    const { workspaceRoot, skillsRoot } = resolveWorkspaceSkillPaths(values.wikiPath);
    const wikiSkillInstall = ensureWikiSkillInstall(values.wikiPath, packageRoot);
    const parserSkillInstalls = values.parserSkills.map((skillName) =>
      installParserSkill(skillName, workspaceRoot, {
        env,
        output,
      }),
    );
    writeSetupEnvFile(values);
    const globalConfig = writeGlobalConfig(values.envFilePath, env);

    output.write(
      [
        "\ntiangong-wiki setup complete",
        `configuration file: ${values.envFilePath}`,
        `default workspace config: ${globalConfig.configPath}`,
        `workspace root: ${workspaceRoot}`,
        `skills root: ${skillsRoot}`,
        `tiangong-wiki-skill: ${wikiSkillInstall.status}`,
        `parser skills: ${values.parserSkills.length > 0 ? values.parserSkills.join(", ") : "(none)"}`,
        `created directories: ${bootstrap.createdDirectories.length}`,
        `copied config: ${bootstrap.copiedConfig}`,
        `copied templates: ${bootstrap.copiedTemplates}`,
        ...(parserSkillInstalls.length > 0
          ? [`installed parser skills: ${parserSkillInstalls.map((item) => `${item.name} (${item.status})`).join(", ")}`]
          : []),
        "",
        "Next steps:",
        `- Commands inside ${JSON.stringify(workspaceRoot)} will auto-discover the local .wiki.env first.`,
        `- Commands outside the workspace will fall back to the default workspace config at ${globalConfig.configPath}.`,
        `- Example: cd ${JSON.stringify(workspaceRoot)} && tiangong-wiki doctor`,
        `- Example: tiangong-wiki --env-file ${JSON.stringify(values.envFilePath)} doctor`,
        `- Example: cd ${JSON.stringify(workspaceRoot)} && tiangong-wiki init`,
        "- Run `tiangong-wiki doctor` to validate the generated configuration.",
        "- Run `tiangong-wiki init` to create index.db and perform the first sync.",
        ...(values.vaultSource === "synology"
          ? ["- Protect `.wiki.env` carefully because it now stores Synology credentials."]
          : []),
        ...(values.agentEnabled
          ? ["- Start the background service with `tiangong-wiki daemon start` or `tiangong-wiki daemon run` once init succeeds."]
          : []),
      ].join("\n"),
    );

    return {
      envFilePath: values.envFilePath,
      globalConfigPath: globalConfig.configPath,
      createdDirectories: bootstrap.createdDirectories,
      copiedConfig: bootstrap.copiedConfig,
      copiedTemplates: bootstrap.copiedTemplates,
      embeddingEnabled: values.embeddingEnabled,
      agentEnabled: values.agentEnabled,
      parserSkills: values.parserSkills,
      skillsRoot,
    };
  } finally {
    driver.close();
  }
}

function inspectDirectory(
  checks: DoctorCheck[],
  id: string,
  label: string,
  dirPath: string | null,
  options: { required?: boolean; recommendation?: string } = {},
): void {
  if (!dirPath) {
    if (options.required !== false) {
      collectDoctorCheck(
        checks,
        "error",
        id,
        `${label} is not configured.`,
        options.recommendation ?? "Run `tiangong-wiki setup` to generate a complete workspace configuration.",
      );
    }
    return;
  }

  if (!pathExistsSync(dirPath)) {
    collectDoctorCheck(
      checks,
      "error",
      id,
      `${label} does not exist: ${dirPath}`,
      options.recommendation ?? `Create the directory or rerun \`tiangong-wiki setup\` to scaffold ${label}.`,
    );
    return;
  }

  try {
    canReadWrite(dirPath);
    collectDoctorCheck(checks, "ok", id, `${label} is readable and writable: ${dirPath}`);
  } catch {
    collectDoctorCheck(
      checks,
      "error",
      id,
      `${label} is not readable and writable: ${dirPath}`,
      `Fix filesystem permissions for ${dirPath}.`,
    );
  }
}

function inspectDbPath(checks: DoctorCheck[], dbPath: string | null): void {
  if (!dbPath) {
    collectDoctorCheck(
      checks,
      "error",
      "db-path",
      "WIKI_DB_PATH is not configured.",
      "Run `tiangong-wiki setup` to record the database path.",
    );
    return;
  }

  if (pathExistsSync(dbPath)) {
    try {
      canReadWrite(dbPath);
      collectDoctorCheck(checks, "ok", "db-path", `index.db is readable and writable: ${dbPath}`);
    } catch {
      collectDoctorCheck(
        checks,
        "error",
        "db-path",
        `index.db exists but is not readable and writable: ${dbPath}`,
        `Fix filesystem permissions for ${dbPath}.`,
      );
    }
    return;
  }

  const parentDir = path.dirname(dbPath);
  if (pathExistsSync(parentDir)) {
    try {
      canWrite(parentDir);
      collectDoctorCheck(
        checks,
        "warn",
        "db-path",
        `index.db does not exist yet and will be created during \`tiangong-wiki init\`: ${dbPath}`,
        "Run `tiangong-wiki init` to create the database and perform the first sync.",
      );
      return;
    } catch {
      // handled below
    }
  }

  collectDoctorCheck(
    checks,
    "error",
    "db-path",
    `index.db cannot be created at ${dbPath}`,
    `Ensure ${parentDir} exists and is writable, or rerun \`tiangong-wiki setup\`.`,
  );
}

async function inspectVaultSource(
  checks: DoctorCheck[],
  env: NodeJS.ProcessEnv,
  probe: boolean,
): Promise<void> {
  let source: VaultSource;
  try {
    source = normalizeVaultSource(env.VAULT_SOURCE);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    collectDoctorCheck(
      checks,
      "error",
      "vault-source",
      message,
      "Set VAULT_SOURCE to local or synology, or rerun `tiangong-wiki setup`.",
    );
    return;
  }

  let hashMode: "content" | "mtime";
  let hashModeValid = true;
  try {
    hashMode = parseVaultHashMode(env.VAULT_HASH_MODE);
  } catch (error) {
    hashModeValid = false;
    const message = error instanceof Error ? error.message : String(error);
    collectDoctorCheck(
      checks,
      "error",
      "vault-hash-mode",
      message,
      "Set VAULT_HASH_MODE to content or mtime, or rerun `tiangong-wiki setup`.",
    );
    hashMode = source === "synology" ? "mtime" : "content";
  }

  if (hashModeValid) {
    collectDoctorCheck(
      checks,
      "ok",
      "vault-source",
      `Vault source is ${source} with ${hashMode} hash mode.`,
    );
  }

  if (source !== "synology") {
    return;
  }

  let remotePath: string;
  try {
    remotePath = normalizeSynologyRemotePath(env.VAULT_SYNOLOGY_REMOTE_PATH);
    collectDoctorCheck(
      checks,
      "ok",
      "synology-remote-path",
      `Synology vault remote path is configured: ${remotePath}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    collectDoctorCheck(
      checks,
      "error",
      "synology-remote-path",
      message,
      "Set VAULT_SYNOLOGY_REMOTE_PATH to the remote vault directory, or rerun `tiangong-wiki setup`.",
    );
    return;
  }

  let config;
  try {
    config = loadSynologyConfigFromEnv(env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    collectDoctorCheck(
      checks,
      "error",
      "synology-config",
      message,
      "Set the required SYNOLOGY_* variables in `.wiki.env` or rerun `tiangong-wiki setup`.",
    );
    return;
  }

  if (!probe) {
    collectDoctorCheck(
      checks,
      "ok",
      "synology-config",
      `Synology connection settings are configured for ${config.baseUrl} (verify SSL: ${config.verifySsl ? "true" : "false"}, readonly: ${config.readonly ? "true" : "false"}).`,
    );
    return;
  }

  collectDoctorCheck(
    checks,
    "ok",
    "synology-config",
    `Synology connection settings are configured for ${config.baseUrl} (verify SSL: ${config.verifySsl ? "true" : "false"}, readonly: ${config.readonly ? "true" : "false"}).`,
  );

  try {
    await withSynologyClient(env, async (client) => {
      await client.probeFolder(remotePath);
    });
    collectDoctorCheck(
      checks,
      "ok",
      "synology-probe",
      `Synology probe succeeded for ${remotePath} via ${config.baseUrl}.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    collectDoctorCheck(
      checks,
      "error",
      "synology-probe",
      `Synology probe failed: ${message}`,
      "Verify SYNOLOGY_BASE_URL, credentials, remote path, and NAS network reachability.",
    );
  }
}

function inspectEmbedding(checks: DoctorCheck[], env: NodeJS.ProcessEnv, probe: boolean): Promise<void> | void {
  const baseUrl = env.EMBEDDING_BASE_URL ?? env.OPENROUTER_BASE_URL;
  const apiKey = env.EMBEDDING_API_KEY ?? env.OPENROUTER_API_KEY;
  const model = env.EMBEDDING_MODEL ?? env.OPENROUTER_EMBEDDING_MODEL;
  const provided = [baseUrl, apiKey, model].filter(Boolean).length;

  if (provided === 0) {
    collectDoctorCheck(
      checks,
      "warn",
      "embedding",
      "Semantic search is disabled because EMBEDDING_* is not configured.",
      "Rerun `tiangong-wiki setup` or update `.wiki.env` to configure EMBEDDING_* if you want `tiangong-wiki search`.",
    );
    return;
  }

  try {
    const client = EmbeddingClient.fromEnv(env);
    if (!client) {
      collectDoctorCheck(
        checks,
        "error",
        "embedding",
        "Embedding configuration is incomplete.",
        "Set EMBEDDING_BASE_URL, EMBEDDING_API_KEY, and EMBEDDING_MODEL together.",
      );
      return;
    }

    if (!probe) {
      collectDoctorCheck(
        checks,
        "ok",
        "embedding",
        `Embedding configuration is complete: ${client.settings.model} @ ${client.settings.baseUrl}`,
      );
      return;
    }

    return client
      .probe()
      .then(() => {
        collectDoctorCheck(
          checks,
          "ok",
          "embedding",
          `Embedding probe succeeded for ${client.settings.model}.`,
        );
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        collectDoctorCheck(
          checks,
          "error",
          "embedding",
          `Embedding probe failed: ${message}`,
          "Verify EMBEDDING_BASE_URL, EMBEDDING_API_KEY, EMBEDDING_MODEL, and network reachability.",
        );
      });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    collectDoctorCheck(
      checks,
      "error",
      "embedding",
      `Embedding configuration is invalid: ${message}`,
      "Fix EMBEDDING_* in `.wiki.env` or rerun `tiangong-wiki setup`.",
    );
  }
}

function inspectAgent(checks: DoctorCheck[], env: NodeJS.ProcessEnv): void {
  try {
    const settings = resolveAgentSettings(env);
    if (!settings.enabled) {
      collectDoctorCheck(
        checks,
        "ok",
        "agent",
        "Automatic vault processing is disabled.",
      );
      return;
    }

    if (settings.missing.length > 0) {
      collectDoctorCheck(
        checks,
        "error",
        "agent",
        `Automatic vault processing is enabled but missing: ${settings.missing.join(", ")}`,
        "Set the missing WIKI_AGENT_* values in `.wiki.env` or rerun `tiangong-wiki setup`.",
      );
      return;
    }

    collectDoctorCheck(
      checks,
      "ok",
      "agent",
      `Automatic vault processing is enabled with model ${settings.model}.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    collectDoctorCheck(
      checks,
      "error",
      "agent",
      `Agent configuration is invalid: ${message}`,
      "Fix WIKI_AGENT_* in `.wiki.env` or rerun `tiangong-wiki setup`.",
    );
  }
}

function inspectWorkspaceSkills(
  checks: DoctorCheck[],
  wikiPath: string | null,
  rawParserSkills: string | undefined,
): {
  workspaceRoot: string | null;
  skillsRoot: string | null;
  requestedParserSkills: ParserSkillName[];
  invalidParserSkills: string[];
  missingSkills: string[];
} {
  if (!wikiPath) {
    collectDoctorCheck(
      checks,
      "error",
      "skills-root",
      "Workspace skill root cannot be derived until WIKI_PATH is configured.",
      "Run `tiangong-wiki setup` to configure WIKI_PATH and install workspace-local skills.",
    );
    collectDoctorCheck(
      checks,
      "error",
      "tiangong-wiki-skill",
      "tiangong-wiki-skill cannot be checked until WIKI_PATH is configured.",
      "Run `tiangong-wiki setup` to configure WIKI_PATH and install workspace-local skills.",
    );
    return {
      workspaceRoot: null,
      skillsRoot: null,
      requestedParserSkills: [],
      invalidParserSkills: [],
      missingSkills: ["tiangong-wiki-skill"],
    };
  }

  const { workspaceRoot, skillsRoot, wikiSkillPath } = resolveWorkspaceSkillPaths(wikiPath);
  inspectDirectory(checks, "skills-root", "WORKSPACE_SKILLS_ROOT", skillsRoot, {
    recommendation: "Run `tiangong-wiki setup` to create workspace-local skills under .agents/skills.",
  });

  const missingSkills: string[] = [];
  const wikiSkill = inspectSkillInstall(wikiSkillPath, "tiangong-wiki-skill");
  if (wikiSkill.readable) {
    collectDoctorCheck(checks, "ok", "tiangong-wiki-skill", `tiangong-wiki-skill is installed: ${wikiSkill.skillMdPath}`);
  } else {
    collectDoctorCheck(
      checks,
      "error",
      "tiangong-wiki-skill",
      `tiangong-wiki-skill is missing or unreadable: ${wikiSkill.skillMdPath}`,
      "Run `tiangong-wiki setup` to install workspace-local tiangong-wiki-skill.",
    );
    missingSkills.push("tiangong-wiki-skill");
  }

  const { skills: requestedParserSkills, invalid: invalidParserSkills } = parseParserSkillSelection(rawParserSkills);
  if (invalidParserSkills.length > 0) {
    collectDoctorCheck(
      checks,
      "error",
      "parser-skills",
      `Parser skill configuration is invalid: ${invalidParserSkills.join(", ")}`,
      "Fix WIKI_PARSER_SKILLS in `.wiki.env` or rerun `tiangong-wiki setup`.",
    );
    return {
      workspaceRoot,
      skillsRoot,
      requestedParserSkills,
      invalidParserSkills,
      missingSkills,
    };
  }

  if (requestedParserSkills.length === 0) {
    collectDoctorCheck(
      checks,
      "ok",
      "parser-skills",
      "No optional parser skills are declared in WIKI_PARSER_SKILLS.",
    );
    return {
      workspaceRoot,
      skillsRoot,
      requestedParserSkills,
      invalidParserSkills,
      missingSkills,
    };
  }

  const missingParserSkills = requestedParserSkills.filter((skillName) => {
    const result = inspectSkillInstall(resolveWorkspaceSkillPath(workspaceRoot, skillName), skillName);
    return !result.readable;
  });

  if (missingParserSkills.length > 0) {
    collectDoctorCheck(
      checks,
      "error",
      "parser-skills",
      `Declared parser skills are missing or unreadable: ${missingParserSkills.join(", ")}`,
      "Rerun `tiangong-wiki setup` or reinstall the missing parser skills into workspace-local .agents/skills.",
    );
    missingSkills.push(...missingParserSkills);
  } else {
    collectDoctorCheck(
      checks,
      "ok",
      "parser-skills",
      `Declared parser skills are installed: ${requestedParserSkills.join(", ")}`,
    );
  }

  return {
    workspaceRoot,
    skillsRoot,
    requestedParserSkills,
    invalidParserSkills,
    missingSkills,
  };
}

function inspectConfigAndTemplates(checks: DoctorCheck[], configPath: string | null, wikiRoot: string | null): void {
  if (!configPath) {
    collectDoctorCheck(
      checks,
      "error",
      "config",
      "WIKI_CONFIG_PATH is not configured.",
      "Run `tiangong-wiki setup` to record the config path.",
    );
    return;
  }

  if (!pathExistsSync(configPath)) {
    collectDoctorCheck(
      checks,
      "error",
      "config",
      `wiki.config.json does not exist: ${configPath}`,
      "Run `tiangong-wiki setup` or `tiangong-wiki init` to scaffold wiki.config.json.",
    );
    return;
  }

  try {
    const config = loadConfig(configPath);
    if (!wikiRoot) {
      collectDoctorCheck(checks, "ok", "config", `Config loaded: ${configPath}`);
      return;
    }

    const missingTemplates = Object.keys(config.templates)
      .map((pageType) => ({
        pageType,
        templatePath: resolveTemplateFilePath(config, wikiRoot, pageType),
      }))
      .filter((entry) => !pathExistsSync(entry.templatePath));

    if (missingTemplates.length > 0) {
      collectDoctorCheck(
        checks,
        "error",
        "templates",
        `Missing template files: ${missingTemplates.map((entry) => entry.pageType).join(", ")}`,
        "Run `tiangong-wiki setup` or restore the missing template files under WIKI_TEMPLATES_PATH.",
      );
      return;
    }

    collectDoctorCheck(
      checks,
      "ok",
      "config",
      `Config loaded successfully with ${Object.keys(config.templates).length} registered templates.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    collectDoctorCheck(
      checks,
      "error",
      "config",
      `Failed to load config: ${message}`,
      "Fix wiki.config.json or rerun `tiangong-wiki setup` to scaffold a clean copy.",
    );
  }
}

function inspectDaemon(checks: DoctorCheck[], wikiRoot: string | null): void {
  if (!wikiRoot) {
    return;
  }

  const pidPath = path.join(wikiRoot, ".wiki-daemon.pid");
  const statePath = path.join(wikiRoot, ".wiki-daemon.state.json");

  if (!pathExistsSync(pidPath)) {
    collectDoctorCheck(
      checks,
      "warn",
      "daemon",
      "The wiki daemon is not running.",
      "Run `tiangong-wiki daemon start` after `tiangong-wiki init` if you want automatic sync cycles.",
    );
    return;
  }

  try {
    const rawPid = readFileSync(pidPath, "utf8").trim();
    const pid = Number.parseInt(rawPid, 10);
    if (!Number.isFinite(pid)) {
      collectDoctorCheck(
        checks,
        "error",
        "daemon",
        `Daemon PID file is invalid: ${pidPath}`,
        "Remove the stale PID file or restart the daemon.",
      );
      return;
    }

    try {
      process.kill(pid, 0);
      collectDoctorCheck(
        checks,
        "ok",
        "daemon",
        `The wiki daemon is running with PID ${pid}${pathExistsSync(statePath) ? " and has a state file." : "."}`,
      );
    } catch {
      collectDoctorCheck(
        checks,
        "error",
        "daemon",
        `Daemon PID file exists but process ${pid} is not running.`,
        "Run `tiangong-wiki daemon stop` to clear stale state, then restart the daemon if needed.",
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    collectDoctorCheck(
      checks,
      "error",
      "daemon",
      `Failed to inspect daemon state: ${message}`,
      "Check the daemon state files under the wiki workspace root.",
    );
  }
}

function summarizeChecks(checks: DoctorCheck[]) {
  return checks.reduce(
    (summary, check) => {
      summary[check.severity] += 1;
      return summary;
    },
    { ok: 0, warn: 0, error: 0 },
  );
}

function uniqueRecommendations(checks: DoctorCheck[]): string[] {
  return Array.from(new Set(checks.map((check) => check.recommendation).filter(Boolean) as string[]));
}

export async function buildDoctorReport(
  env: NodeJS.ProcessEnv = process.env,
  options: { probe?: boolean } = {},
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const envFile = getCliEnvironmentInfo();

  if (envFile.missingRequestedPath && envFile.requestedPath) {
    collectDoctorCheck(
      checks,
      "error",
      "env-file",
      `Requested env file does not exist: ${envFile.requestedPath}`,
      "Create the env file or rerun `tiangong-wiki setup`.",
    );
  } else if (envFile.missingDefaultPath && envFile.defaultPath) {
    collectDoctorCheck(
      checks,
      "error",
      "env-file",
      `The default workspace config points to a missing env file: ${envFile.defaultPath}`,
      envFile.globalConfigPath
        ? `Fix or remove ${envFile.globalConfigPath}, rerun \`tiangong-wiki setup\`, or pass \`--env-file\` explicitly.`
        : "Fix the default workspace config, rerun `tiangong-wiki setup`, or pass `--env-file` explicitly.",
    );
  } else if (envFile.loadedPath) {
    const sourceLabel =
      envFile.source === "explicit-env-file"
        ? "from --env-file or WIKI_ENV_FILE."
        : envFile.source === "nearest-env-file"
          ? "from the current workspace (auto-discovered)."
          : envFile.source === "global-default-env-file"
            ? "from the global default workspace config."
            : ".";
    collectDoctorCheck(
      checks,
      "ok",
      "env-file",
      `Loaded configuration from ${envFile.loadedPath} ${sourceLabel}`,
    );
  } else if (envFile.source === "process-env") {
    collectDoctorCheck(
      checks,
      "ok",
      "env-file",
      "Using runtime paths provided directly via process.env; no .wiki.env file was loaded.",
    );
  } else {
    collectDoctorCheck(
      checks,
      "warn",
      "env-file",
      "No workspace configuration was found from --env-file, WIKI_ENV_FILE, the current directory, or the global default workspace config.",
      "Run `tiangong-wiki setup`, set `WIKI_ENV_FILE`, or pass `--env-file` to point at a workspace explicitly.",
    );
  }

  const wikiPath = env.WIKI_PATH ? path.resolve(env.WIKI_PATH) : null;
  const wikiRoot = wikiPath ? path.resolve(wikiPath, "..") : null;
  const workspaceRoot = wikiPath ? resolveWorkspaceRootFromWikiPath(wikiPath) : null;
  const vaultPath = wikiRoot ? path.resolve(env.VAULT_PATH ?? path.join(wikiRoot, "..", "vault")) : null;
  const dbPath = wikiRoot ? path.resolve(env.WIKI_DB_PATH ?? path.join(wikiRoot, "index.db")) : null;
  const configPath = wikiRoot ? path.resolve(env.WIKI_CONFIG_PATH ?? path.join(wikiRoot, "wiki.config.json")) : null;
  const templatesPath = wikiRoot ? path.resolve(env.WIKI_TEMPLATES_PATH ?? path.join(wikiRoot, "templates")) : null;
  const skillStatus = inspectWorkspaceSkills(checks, wikiPath, env.WIKI_PARSER_SKILLS);

  inspectDirectory(checks, "wiki-path", "WIKI_PATH", wikiPath, {
    recommendation: "Run `tiangong-wiki setup` to generate WIKI_PATH and scaffold wiki/pages.",
  });
  inspectDirectory(checks, "vault-path", "VAULT_PATH", vaultPath, {
    recommendation: "Run `tiangong-wiki setup` to generate VAULT_PATH and scaffold the vault directory.",
  });
  inspectDirectory(checks, "templates-path", "WIKI_TEMPLATES_PATH", templatesPath, {
    recommendation: "Run `tiangong-wiki setup` or restore template files under WIKI_TEMPLATES_PATH.",
  });
  await inspectVaultSource(checks, env, options.probe === true);
  inspectDbPath(checks, dbPath);
  inspectConfigAndTemplates(checks, configPath, wikiRoot);
  await inspectEmbedding(checks, env, options.probe === true);
  inspectAgent(checks, env);
  inspectDaemon(checks, wikiRoot);

  const summary = summarizeChecks(checks);
  return {
    ok: summary.error === 0,
    summary,
    envFile: {
      requestedPath: envFile.requestedPath,
      loadedPath: envFile.loadedPath,
      autoDiscovered: envFile.autoDiscovered,
      missingRequestedPath: envFile.missingRequestedPath,
      missingDefaultPath: envFile.missingDefaultPath,
      source: envFile.source,
      globalConfigPath: envFile.globalConfigPath,
      defaultPath: envFile.defaultPath,
    },
    effectivePaths: {
      wikiPath,
      workspaceRoot,
      vaultPath,
      dbPath,
      configPath,
      templatesPath,
      skillsRoot: skillStatus.skillsRoot,
    },
    skills: {
      requestedParserSkills: skillStatus.requestedParserSkills,
      invalidParserSkills: skillStatus.invalidParserSkills,
      missingSkills: skillStatus.missingSkills,
    },
    checks,
    recommendations: uniqueRecommendations(checks),
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = ["tiangong-wiki doctor", ""];

  for (const check of report.checks) {
    lines.push(`${check.severity.toUpperCase().padEnd(5)} ${check.id.padEnd(14)} ${check.summary}`);
  }

  lines.push("");
  lines.push(`Summary: ${report.summary.ok} ok, ${report.summary.warn} warn, ${report.summary.error} error`);

  if (report.recommendations.length > 0) {
    lines.push("");
    lines.push("Recommended actions:");
    for (const recommendation of report.recommendations) {
      lines.push(`- ${recommendation}`);
    }
  }

  return lines.join("\n");
}
