import type { WorkflowResultManifest } from "./workflow-result.js";
import type { TemplateEvolutionMode } from "../types/page.js";
import { AppError } from "../utils/errors.js";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

export interface TemplateEvolutionSettings {
  enabled: boolean;
  mode: TemplateEvolutionMode;
  canApply: boolean;
}

function parseBooleanFlag(label: string, rawValue: string | undefined, defaultValue: boolean): boolean {
  if (rawValue === undefined) {
    return defaultValue;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) {
    return true;
  }
  if (FALSE_VALUES.has(normalized)) {
    return false;
  }

  throw new AppError(`${label} must be a boolean value, got ${rawValue}`, "config");
}

function parseMode(rawValue: string | undefined): TemplateEvolutionMode {
  const normalized = (rawValue ?? "proposal").trim().toLowerCase();
  if (normalized === "proposal" || normalized === "apply") {
    return normalized;
  }

  throw new AppError(
    `WIKI_AGENT_TEMPLATE_EVOLUTION_MODE must be "proposal" or "apply", got ${rawValue}`,
    "config",
  );
}

export function resolveTemplateEvolutionSettings(
  env: NodeJS.ProcessEnv = process.env,
): TemplateEvolutionSettings {
  const enabled = parseBooleanFlag(
    "WIKI_AGENT_ALLOW_TEMPLATE_EVOLUTION",
    env.WIKI_AGENT_ALLOW_TEMPLATE_EVOLUTION,
    false,
  );
  const mode = parseMode(env.WIKI_AGENT_TEMPLATE_EVOLUTION_MODE);
  return {
    enabled,
    mode,
    canApply: enabled && mode === "apply",
  };
}

export function assertTemplateEvolutionAllowed(
  manifest: WorkflowResultManifest,
  settings: TemplateEvolutionSettings,
): void {
  const requestedTemplateCreation = manifest.actions.some((action) => action.kind === "create_template");
  if (requestedTemplateCreation && !settings.canApply) {
    throw new AppError(
      "Template evolution action is not allowed. Set WIKI_AGENT_ALLOW_TEMPLATE_EVOLUTION=true and WIKI_AGENT_TEMPLATE_EVOLUTION_MODE=apply to permit template creation.",
      "config",
    );
  }
}
