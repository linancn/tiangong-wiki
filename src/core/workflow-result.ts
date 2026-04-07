import { AppError } from "../utils/errors.js";
import { pathExistsSync, readTextFileSync } from "../utils/fs.js";

export type WorkflowResultStatus = "done" | "skipped" | "error";
export type WorkflowDecision = "skip" | "apply" | "propose_only";
export type WorkflowActionKind = "create_page" | "update_page" | "create_template";

export interface WorkflowProposedType {
  name: string;
  reason: string;
  suggestedTemplateSections: string[];
}

export interface WorkflowAction {
  kind: WorkflowActionKind;
  summary: string;
  pageType?: string;
  pageId?: string;
  title?: string;
}

export interface WorkflowLintResult {
  pageId: string;
  errors: number;
  warnings: number;
}

export interface WorkflowResultManifest {
  status: WorkflowResultStatus;
  decision: WorkflowDecision;
  reason: string;
  threadId: string;
  skillsUsed: string[];
  createdPageIds: string[];
  updatedPageIds: string[];
  appliedTypeNames: string[];
  proposedTypes: WorkflowProposedType[];
  actions: WorkflowAction[];
  lint: WorkflowLintResult[];
  sourceFile?: {
    path: string;
    sha256?: string;
  };
}

function fail(message: string, details?: unknown): never {
  throw new AppError(message, "runtime", details);
}

function ensureRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function ensureString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    fail(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function ensureStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    fail(`${label} must be an array`);
  }

  return value.map((entry, index) => ensureString(entry, `${label}[${index}]`));
}

function ensureNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${label} must be a finite number`);
  }
  return value;
}

function ensureStatus(value: unknown): WorkflowResultStatus {
  const status = ensureString(value, "result.status");
  if (status === "done" || status === "skipped" || status === "error") {
    return status;
  }
  fail(`result.status must be one of done, skipped, error`);
}

function ensureDecision(value: unknown): WorkflowDecision {
  const decision = ensureString(value, "result.decision");
  if (decision === "skip" || decision === "apply" || decision === "propose_only") {
    return decision;
  }
  fail(`result.decision must be one of skip, apply, propose_only`);
}

function parseSourceFile(value: unknown): WorkflowResultManifest["sourceFile"] {
  if (value === undefined) {
    return undefined;
  }

  const sourceFile = ensureRecord(value, "result.sourceFile");
  const path = ensureString(sourceFile.path, "result.sourceFile.path");
  const sha256 =
    sourceFile.sha256 === undefined ? undefined : ensureString(sourceFile.sha256, "result.sourceFile.sha256");
  return { path, ...(sha256 ? { sha256 } : {}) };
}

function parseProposedTypes(value: unknown): WorkflowProposedType[] {
  if (!Array.isArray(value)) {
    fail("result.proposedTypes must be an array");
  }

  return value.map((entry, index) => {
    const proposed = ensureRecord(entry, `result.proposedTypes[${index}]`);
    return {
      name: ensureString(proposed.name, `result.proposedTypes[${index}].name`),
      reason: ensureString(proposed.reason, `result.proposedTypes[${index}].reason`),
      suggestedTemplateSections: ensureStringArray(
        proposed.suggestedTemplateSections,
        `result.proposedTypes[${index}].suggestedTemplateSections`,
      ),
    };
  });
}

function parseActions(value: unknown): WorkflowAction[] {
  if (!Array.isArray(value)) {
    fail("result.actions must be an array");
  }

  return value.map((entry, index) => {
    const action = ensureRecord(entry, `result.actions[${index}]`);
    const kind = ensureString(action.kind, `result.actions[${index}].kind`);
    if (kind !== "create_page" && kind !== "update_page" && kind !== "create_template") {
      fail(`result.actions[${index}].kind must be create_page, update_page, or create_template`);
    }

    const parsed: WorkflowAction = {
      kind,
      summary: ensureString(action.summary, `result.actions[${index}].summary`),
    };

    if (action.pageType !== undefined) {
      parsed.pageType = ensureString(action.pageType, `result.actions[${index}].pageType`);
    }

    if (action.pageId !== undefined) {
      parsed.pageId = ensureString(action.pageId, `result.actions[${index}].pageId`);
    }
    if (action.title !== undefined) {
      parsed.title = ensureString(action.title, `result.actions[${index}].title`);
    }

    if ((kind === "create_page" || kind === "create_template") && !parsed.pageType) {
      fail(`result.actions[${index}].pageType must be provided for ${kind}`);
    }
    if (kind === "create_page" && !parsed.title) {
      fail(`result.actions[${index}].title must be provided for create_page`);
    }
    if (kind === "update_page" && !parsed.pageId) {
      fail(`result.actions[${index}].pageId must be provided for update_page`);
    }
    if (kind === "create_template" && !parsed.title) {
      fail(`result.actions[${index}].title must be provided for create_template`);
    }

    return parsed;
  });
}

function parseLint(value: unknown): WorkflowLintResult[] {
  if (!Array.isArray(value)) {
    fail("result.lint must be an array");
  }

  return value.map((entry, index) => {
    const lint = ensureRecord(entry, `result.lint[${index}]`);
    return {
      pageId: ensureString(lint.pageId, `result.lint[${index}].pageId`),
      errors: ensureNumber(lint.errors, `result.lint[${index}].errors`),
      warnings: ensureNumber(lint.warnings, `result.lint[${index}].warnings`),
    };
  });
}

export function parseWorkflowResult(raw: unknown): WorkflowResultManifest {
  try {
    const result = ensureRecord(raw, "result");
    const manifest: WorkflowResultManifest = {
      status: ensureStatus(result.status),
      decision: ensureDecision(result.decision),
      reason: ensureString(result.reason, "result.reason"),
      threadId: ensureString(result.threadId, "result.threadId"),
      skillsUsed: ensureStringArray(result.skillsUsed, "result.skillsUsed"),
      createdPageIds: ensureStringArray(result.createdPageIds, "result.createdPageIds"),
      updatedPageIds: ensureStringArray(result.updatedPageIds, "result.updatedPageIds"),
      appliedTypeNames: ensureStringArray(result.appliedTypeNames, "result.appliedTypeNames"),
      proposedTypes: parseProposedTypes(result.proposedTypes),
      actions: parseActions(result.actions),
      lint: parseLint(result.lint),
      sourceFile: parseSourceFile(result.sourceFile),
    };

    if (manifest.decision === "apply" && manifest.actions.length === 0) {
      fail("result.actions must contain at least one action when decision=apply");
    }

    return manifest;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    fail("Failed to parse workflow result", { cause: error instanceof Error ? error.message : String(error) });
  }
}

export function readWorkflowResult(resultPath: string): WorkflowResultManifest {
  if (!pathExistsSync(resultPath)) {
    fail(`Workflow result not found: ${resultPath}`);
  }

  const rawText = readTextFileSync(resultPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    fail("Workflow result is not valid JSON", {
      resultPath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  return parseWorkflowResult(parsed);
}
