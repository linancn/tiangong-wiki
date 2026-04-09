import { copyFileSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";

import { resolveRuntimePaths } from "../core/paths.js";
import { AppError } from "../utils/errors.js";
import {
  findCandidates,
  nextAvailableName,
  resolveAssetDir,
  toPosixSlashes,
  toSlug,
  validateSlug,
  validateSourceFile,
} from "../utils/asset.js";
import { ensureDirSync, pathExistsSync } from "../utils/fs.js";

export interface AssetSaveResult {
  assetPath: string;
}

export interface AssetRefResult {
  relativePath: string;
  assetPath: string;
}

export interface AssetRefCandidatesResult {
  match: "candidates";
  message: string;
  candidates: AssetRefResult[];
}

export function saveAsset(
  env: NodeJS.ProcessEnv,
  sourceFile: string,
  options: { name?: string; type?: string } = {},
): AssetSaveResult {
  const assetType = options.type ?? "image";
  const { wikiRoot } = resolveRuntimePaths(env);
  const absSource = path.resolve(sourceFile);

  validateSourceFile(absSource);

  const sourceExt = path.extname(absSource).replace(/^\./, "").toLowerCase();
  if (!sourceExt) {
    throw new AppError("Source file has no extension", "config");
  }

  const name = options.name ? (validateSlug(options.name), options.name) : toSlug(path.basename(absSource, path.extname(absSource)));

  const assetDir = resolveAssetDir(wikiRoot, assetType);
  ensureDirSync(assetDir);

  const finalName = nextAvailableName(assetDir, name, sourceExt);
  const finalPath = path.join(assetDir, finalName);

  const tmpName = `.tmp-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${sourceExt}`;
  const tmpPath = path.join(assetDir, tmpName);

  try {
    copyFileSync(absSource, tmpPath);
    renameSync(tmpPath, finalPath);
  } catch (err) {
    try {
      if (pathExistsSync(tmpPath)) { unlinkSync(tmpPath); }
    } catch {
      // ignore cleanup errors
    }
    throw new AppError(
      `Failed to save asset: ${err instanceof Error ? err.message : String(err)}`,
      "runtime",
    );
  }

  return {
    assetPath: toPosixSlashes(path.relative(wikiRoot, finalPath)),
  };
}

export function refAsset(
  env: NodeJS.ProcessEnv,
  assetPathOrName: string,
  options: { page: string; type?: string },
): AssetRefResult | AssetRefCandidatesResult {
  const assetType = options.type ?? "image";
  const { wikiRoot, wikiPath } = resolveRuntimePaths(env);

  // Normalize: if no directory separator, treat as filename and prepend type dir
  const assetRelPath = assetPathOrName.includes("/") || assetPathOrName.includes("\\")
    ? assetPathOrName
    : toPosixSlashes(path.join(resolveAssetDir("", assetType), assetPathOrName));

  const absAssetPath = path.join(wikiRoot, assetRelPath);
  const absPageDir = path.dirname(path.join(wikiPath, options.page));

  if (pathExistsSync(absAssetPath)) {
    const rel = path.relative(absPageDir, absAssetPath);
    return {
      relativePath: toPosixSlashes(rel),
      assetPath: toPosixSlashes(assetRelPath),
    };
  }

  // Try candidate matching
  const assetDir = resolveAssetDir(wikiRoot, assetType);
  const fileName = path.basename(assetPathOrName);
  const ext = path.extname(fileName).replace(/^\./, "");
  const baseName = path.basename(fileName, path.extname(fileName));

  if (ext && baseName) {
    const candidates = findCandidates(assetDir, baseName, ext);
    if (candidates.length > 0) {
      return {
        match: "candidates",
        message: `${fileName} not found, but similar files exist`,
        candidates: candidates.map((c) => {
          const cAssetPath = toPosixSlashes(path.relative(wikiRoot, path.join(assetDir, c)));
          const cRelPath = path.relative(absPageDir, path.join(assetDir, c));
          return {
            relativePath: toPosixSlashes(cRelPath),
            assetPath: cAssetPath,
          };
        }),
      };
    }
  }

  throw new AppError(`Asset not found: ${assetPathOrName}`, "not_found");
}
