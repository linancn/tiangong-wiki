import { spawnSync } from "node:child_process";
import path from "node:path";

import type { RuntimePaths, WriteActorMetadata } from "../types/page.js";
import { pathExistsSync } from "../utils/fs.js";
import { AppError } from "../utils/errors.js";

export interface GitCommitJournalResult {
  status: "committed" | "no_changes";
  commitHash: string | null;
}

function buildGitEnv(actor: WriteActorMetadata): NodeJS.ProcessEnv {
  const emailLocalPart = actor.actorId.replace(/[^A-Za-z0-9._-]+/g, "_");
  return {
    ...process.env,
    GIT_AUTHOR_NAME: actor.actorId,
    GIT_AUTHOR_EMAIL: `${emailLocalPart}@tiangong-wiki.local`,
    GIT_COMMITTER_NAME: actor.actorId,
    GIT_COMMITTER_EMAIL: `${emailLocalPart}@tiangong-wiki.local`,
  };
}

function runGit(
  paths: RuntimePaths,
  actor: WriteActorMetadata,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", ["-C", paths.wikiRoot, ...args], {
    encoding: "utf8",
    env: buildGitEnv(actor),
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function collectStageTargets(paths: RuntimePaths): string[] {
  return [
    path.relative(paths.wikiRoot, paths.wikiPath),
    path.relative(paths.wikiRoot, paths.dbPath),
    path.relative(paths.wikiRoot, paths.templatesPath),
    path.relative(paths.wikiRoot, paths.configPath),
    path.relative(paths.wikiRoot, paths.queueArtifactsPath),
  ].filter((entry, index, values) => entry && !entry.startsWith("..") && values.indexOf(entry) === index && pathExistsSync(path.join(paths.wikiRoot, entry)));
}

export function commitWriteJournal(
  paths: RuntimePaths,
  actor: WriteActorMetadata,
  input: {
    operation: string;
    resourceId: string | null;
  },
): GitCommitJournalResult {
  const gitRoot = runGit(paths, actor, ["rev-parse", "--show-toplevel"]);
  if (gitRoot.status !== 0) {
    throw new AppError("Git repository not initialized for wiki root.", "runtime", {
      code: "git_commit_failed",
      stderr: gitRoot.stderr.trim() || gitRoot.stdout.trim(),
    });
  }

  const targets = collectStageTargets(paths);
  const addResult = runGit(paths, actor, ["add", "-A", "--", ...targets]);
  if (addResult.status !== 0) {
    throw new AppError("Failed to stage wiki changes for Git commit.", "runtime", {
      code: "git_commit_failed",
      stderr: addResult.stderr.trim() || addResult.stdout.trim(),
    });
  }

  const diffResult = runGit(paths, actor, ["diff", "--cached", "--quiet", "--exit-code"]);
  if (diffResult.status === 0) {
    return {
      status: "no_changes",
      commitHash: null,
    };
  }
  if (diffResult.status !== 1) {
    throw new AppError("Failed to inspect staged Git changes.", "runtime", {
      code: "git_commit_failed",
      stderr: diffResult.stderr.trim() || diffResult.stdout.trim(),
    });
  }

  const commitMessage = `wiki: ${input.operation} ${input.resourceId ?? "*"} by ${actor.actorId}`;
  const commitResult = runGit(paths, actor, ["commit", "-m", commitMessage]);
  if (commitResult.status !== 0) {
    throw new AppError("Failed to create Git journal commit.", "runtime", {
      code: "git_commit_failed",
      stderr: commitResult.stderr.trim() || commitResult.stdout.trim(),
      commitMessage,
    });
  }

  const hashResult = runGit(paths, actor, ["rev-parse", "HEAD"]);
  if (hashResult.status !== 0) {
    throw new AppError("Failed to resolve Git commit hash.", "runtime", {
      code: "git_commit_failed",
      stderr: hashResult.stderr.trim() || hashResult.stdout.trim(),
    });
  }

  return {
    status: "committed",
    commitHash: hashResult.stdout.trim(),
  };
}

export class GitPushScheduler {
  private readonly enabled: boolean;
  private readonly delayMs: number;
  private readonly remote: string;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly paths: RuntimePaths,
    private readonly log: (message: string) => void,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.enabled = (env.WIKI_GIT_AUTO_PUSH ?? "").trim().toLowerCase() === "true";
    this.delayMs = Number.parseInt(env.WIKI_GIT_PUSH_DELAY_MS ?? "3000", 10) || 3000;
    this.remote = env.WIKI_GIT_PUSH_REMOTE?.trim() || "origin";
  }

  schedule(actor: WriteActorMetadata): boolean {
    if (!this.enabled || this.timer) {
      return false;
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      const result = runGit(this.paths, actor, ["push", this.remote, "HEAD"]);
      if (result.status === 0) {
        this.log(`git push ok remote=${this.remote}`);
        return;
      }
      this.log(`git push failed remote=${this.remote}: ${result.stderr.trim() || result.stdout.trim()}`);
    }, this.delayMs);
    return true;
  }
}
