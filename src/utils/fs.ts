import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export function ensureDirSync(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

export function pathExistsSync(filePath: string): boolean {
  return existsSync(filePath);
}

export function readTextFileSync(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

export function writeTextFileSync(filePath: string, content: string): void {
  ensureDirSync(path.dirname(filePath));
  writeFileSync(filePath, content, "utf8");
}

export function copyFileIfMissingSync(sourcePath: string, targetPath: string): boolean {
  if (existsSync(targetPath)) {
    return false;
  }

  ensureDirSync(path.dirname(targetPath));
  copyFileSync(sourcePath, targetPath);
  return true;
}

export function copyDirectoryContentsSync(sourceDir: string, targetDir: string): void {
  ensureDirSync(targetDir);

  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      copyDirectoryContentsSync(sourcePath, targetPath);
      continue;
    }

    ensureDirSync(path.dirname(targetPath));
    copyFileSync(sourcePath, targetPath);
  }
}

export function isDirectoryEmptySync(dirPath: string): boolean {
  if (!existsSync(dirPath)) {
    return true;
  }

  return readdirSync(dirPath).length === 0;
}

export function listFilesRecursiveSync(rootDir: string, extension?: string): string[] {
  if (!existsSync(rootDir)) {
    return [];
  }

  const results: string[] = [];

  const visit = (dirPath: string): void => {
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }

      if (extension && path.extname(entry.name) !== extension) {
        continue;
      }

      results.push(entryPath);
    }
  };

  visit(rootDir);
  return results.sort();
}

export function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function sha256FileSync(filePath: string): string {
  return sha256Buffer(readFileSync(filePath));
}

export function fileStatSync(filePath: string): { size: number; mtimeMs: number } {
  const stats = statSync(filePath);
  return { size: stats.size, mtimeMs: stats.mtimeMs };
}
