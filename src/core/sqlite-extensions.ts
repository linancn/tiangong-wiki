import path from "node:path";

import type Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

import type { LoadedWikiConfig } from "../types/config.js";
import { AppError } from "../utils/errors.js";
import { pathExistsSync } from "../utils/fs.js";
import { isSimpleTokenizerSql } from "./fts.js";
import { getPackageRoot } from "./paths.js";

export const BUNDLED_SIMPLE_EXTENSION_VERSION = "v0.7.1";

const SIMPLE_ASSET_MAP: Record<string, Record<string, string>> = {
  darwin: {
    arm64: "assets/sqlite-extensions/darwin-arm64/libsimple.dylib",
    x64: "assets/sqlite-extensions/darwin-x64/libsimple.dylib",
  },
  linux: {
    x64: "assets/sqlite-extensions/linux-x64/libsimple.so",
  },
  win32: {
    x64: "assets/sqlite-extensions/win32-x64/simple.dll",
  },
};

export interface SqliteExtensionLoadResult {
  simpleLoaded: boolean;
  loadedSimpleVersion: string | null;
  simpleExtensionPath: string | null;
}

function getExistingFtsSql(db: Database.Database): string | null {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type IN ('table', 'view') AND name = 'pages_fts'")
    .get() as { sql?: string | null } | undefined;
  return row?.sql ?? null;
}

export function resolveBundledSimpleExtensionRelativePath(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string {
  const byArch = SIMPLE_ASSET_MAP[platform];
  if (!byArch) {
    throw new AppError(
      `Bundled simple extension is not available for platform ${platform}-${arch}.`,
      "config",
      {
        platform,
        arch,
      },
    );
  }

  const relativePath = byArch[arch];
  if (!relativePath) {
    throw new AppError(
      `Bundled simple extension is not available for platform ${platform}-${arch}.`,
      "config",
      {
        platform,
        arch,
      },
    );
  }

  return relativePath;
}

function resolveBundledSimpleExtensionPath(packageRoot: string): string {
  const relativePath = resolveBundledSimpleExtensionRelativePath();

  const extensionPath = path.join(packageRoot, relativePath);
  if (!pathExistsSync(extensionPath)) {
    throw new AppError(`Bundled simple extension not found: ${extensionPath}`, "runtime", {
      platform: process.platform,
      arch: process.arch,
      extensionPath,
      version: BUNDLED_SIMPLE_EXTENSION_VERSION,
    });
  }

  return extensionPath;
}

export function loadSqliteExtensions(
  db: Database.Database,
  config: LoadedWikiConfig,
  packageRoot?: string,
): SqliteExtensionLoadResult {
  sqliteVec.load(db);

  const shouldLoadSimple = config.fts.tokenizer === "simple" || isSimpleTokenizerSql(getExistingFtsSql(db));
  if (!shouldLoadSimple) {
    return {
      simpleLoaded: false,
      loadedSimpleVersion: null,
      simpleExtensionPath: null,
    };
  }

  const simpleExtensionPath = resolveBundledSimpleExtensionPath(packageRoot ?? getPackageRoot());
  try {
    db.loadExtension(simpleExtensionPath);
  } catch (error) {
    throw new AppError(`Failed to load bundled simple extension: ${simpleExtensionPath}`, "runtime", {
      extensionPath: simpleExtensionPath,
      version: BUNDLED_SIMPLE_EXTENSION_VERSION,
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    simpleLoaded: true,
    loadedSimpleVersion: BUNDLED_SIMPLE_EXTENSION_VERSION,
    simpleExtensionPath,
  };
}
