import { readdirSync, statSync } from "node:fs";
import path from "node:path";

import { AppError } from "./errors.js";
import { pathExistsSync } from "./fs.js";

export const ASSET_TYPE_DIRS: Record<string, string> = {
  image: "assets/images",
};

const SLUG_PATTERN = /^[a-z0-9-]{1,80}$/;
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB

export function resolveAssetDir(wikiRoot: string, assetType: string): string {
  const subdir = ASSET_TYPE_DIRS[assetType];
  if (!subdir) {
    throw new AppError(
      `Unsupported asset type: ${assetType}. Supported: ${Object.keys(ASSET_TYPE_DIRS).join(", ")}`,
      "config",
    );
  }
  return path.join(wikiRoot, subdir);
}

export function validateSlug(name: string): void {
  if (!SLUG_PATTERN.test(name)) {
    throw new AppError(
      `Invalid asset name: ${name} (must match [a-z0-9-], 1-80 chars)`,
      "config",
    );
  }
}

export function toSlug(rawName: string): string {
  const slug = rawName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!slug) {
    throw new AppError("Cannot derive a valid slug from the source filename", "config");
  }
  return slug;
}

export function validateSourceFile(filePath: string): void {
  if (!pathExistsSync(filePath)) {
    throw new AppError(`Source file not found: ${filePath}`, "not_found");
  }
  const stat = statSync(filePath);
  if (!stat.isFile()) {
    throw new AppError(`Source path is not a regular file: ${filePath}`, "config");
  }
  if (stat.size > MAX_FILE_SIZE_BYTES) {
    const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
    throw new AppError(`File too large: ${sizeMB}MB (max 20MB)`, "config");
  }
}

export function nextAvailableName(dir: string, name: string, ext: string): string {
  const base = `${name}.${ext}`;
  if (!pathExistsSync(path.join(dir, base))) {
    return base;
  }
  for (let i = 1; ; i++) {
    const candidate = `${name}-${i}.${ext}`;
    if (!pathExistsSync(path.join(dir, candidate))) {
      return candidate;
    }
  }
}

export function findCandidates(dir: string, name: string, ext: string): string[] {
  if (!pathExistsSync(dir)) {
    return [];
  }
  const pattern = new RegExp(`^${escapeRegExp(name)}(-\\d+)?\\.${escapeRegExp(ext)}$`);
  try {
    return readdirSync(dir).filter((entry) => pattern.test(entry)).sort();
  } catch {
    return [];
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function toPosixSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}
