import { statSync } from "node:fs";
import path from "node:path";

import type { AgentProcessingSettings } from "../types/page.js";

export interface WikiAgentCodexLoginInspection {
  checked: boolean;
  ready: boolean;
  codexHome: string | null;
  authJsonPath: string | null;
  summary: string;
  recommendation?: string;
}

type PathKind = "directory" | "file" | "other" | "missing" | "inaccessible";

function inspectPathKind(targetPath: string): { kind: PathKind; errorMessage?: string } {
  try {
    const stats = statSync(targetPath);
    if (stats.isDirectory()) {
      return { kind: "directory" };
    }
    if (stats.isFile()) {
      return { kind: "file" };
    }
    return { kind: "other" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { kind: "missing" };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "inaccessible", errorMessage: message };
  }
}

function codexLoginRecommendation(codexHome: string): string {
  return `Run \`CODEX_HOME=${codexHome} codex login\` before starting automatic vault processing.`;
}

export function inspectWikiAgentCodexLogin(
  settings: AgentProcessingSettings,
): WikiAgentCodexLoginInspection {
  if (!settings.enabled || settings.authMode !== "codex-login") {
    return {
      checked: false,
      ready: true,
      codexHome: settings.codexHome,
      authJsonPath: null,
      summary: "Codex login auth is not enabled.",
    };
  }

  if (!settings.codexHome) {
    return {
      checked: true,
      ready: false,
      codexHome: null,
      authJsonPath: null,
      summary: "WIKI_AGENT_CODEX_HOME is not configured for codex-login auth.",
      recommendation: "Set WIKI_AGENT_CODEX_HOME or rerun `tiangong-wiki setup`.",
    };
  }

  const codexHome = settings.codexHome;
  const authJsonPath = path.join(codexHome, "auth.json");
  const home = inspectPathKind(codexHome);

  if (home.kind === "missing") {
    return {
      checked: true,
      ready: false,
      codexHome,
      authJsonPath,
      summary: `WIKI_AGENT_CODEX_HOME does not exist: ${codexHome}`,
      recommendation: codexLoginRecommendation(codexHome),
    };
  }

  if (home.kind !== "directory") {
    return {
      checked: true,
      ready: false,
      codexHome,
      authJsonPath,
      summary:
        home.kind === "inaccessible"
          ? `WIKI_AGENT_CODEX_HOME cannot be inspected: ${codexHome} (${home.errorMessage})`
          : `WIKI_AGENT_CODEX_HOME is not a directory: ${codexHome}`,
      recommendation: codexLoginRecommendation(codexHome),
    };
  }

  const authJson = inspectPathKind(authJsonPath);
  if (authJson.kind === "missing") {
    return {
      checked: true,
      ready: false,
      codexHome,
      authJsonPath,
      summary: `Codex login auth.json was not found under WIKI_AGENT_CODEX_HOME: ${authJsonPath}`,
      recommendation: codexLoginRecommendation(codexHome),
    };
  }

  if (authJson.kind !== "file") {
    return {
      checked: true,
      ready: false,
      codexHome,
      authJsonPath,
      summary:
        authJson.kind === "inaccessible"
          ? `Codex login auth.json cannot be inspected: ${authJsonPath} (${authJson.errorMessage})`
          : `Codex login auth.json is not a file: ${authJsonPath}`,
      recommendation: codexLoginRecommendation(codexHome),
    };
  }

  return {
    checked: true,
    ready: true,
    codexHome,
    authJsonPath,
    summary: `Codex login auth is available at ${codexHome}.`,
  };
}
