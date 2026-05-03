import { spawn } from "node:child_process";
import { openSync } from "node:fs";

import { AppError } from "./errors.js";

interface Invocation {
  command: string;
  args: string[];
}

export interface OpenTargetInvocation {
  command: string;
  args: string[];
}

export function getCurrentInvocation(): Invocation {
  const [, argv1, argv2] = process.argv;
  if (!argv1) {
    return { command: process.execPath, args: [] };
  }

  const looksLikeTsx = argv1.includes("tsx");
  if (looksLikeTsx && argv2) {
    return {
      command: process.execPath,
      args: [argv1, argv2],
    };
  }

  return {
    command: process.execPath,
    args: [argv1],
  };
}

export function buildDetachedSpawnOptions(
  options: { env?: NodeJS.ProcessEnv; logFile?: string } = {},
): {
  detached: true;
  stdio: "ignore" | ["ignore", number, number];
  env: NodeJS.ProcessEnv;
  windowsHide: true;
} {
  const stdio: "ignore" | ["ignore", number, number] = options.logFile
    ? ["ignore", openSync(options.logFile, "a"), openSync(options.logFile, "a")]
    : "ignore";

  return {
    detached: true,
    stdio,
    env: options.env ?? process.env,
    windowsHide: true,
  };
}

export function spawnDetachedCurrentProcess(
  extraArgs: string[],
  options: { env?: NodeJS.ProcessEnv; logFile?: string } = {},
): number | undefined {
  const invocation = getCurrentInvocation();
  const child = spawn(invocation.command, [...invocation.args, ...extraArgs], buildDetachedSpawnOptions(options));
  child.unref();
  return child.pid;
}

export function buildOpenTargetInvocation(
  target: string,
  platform: NodeJS.Platform = process.platform,
): OpenTargetInvocation {
  if (platform === "darwin") {
    return { command: "open", args: [target] };
  }
  if (platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", target] };
  }
  return { command: "xdg-open", args: [target] };
}

export function openTarget(target: string): void {
  const { command, args } = buildOpenTargetInvocation(target);
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      shell: false,
      windowsHide: true,
    });
    child.unref();
  } catch (error) {
    throw new AppError(
      `Failed to open target ${target}: ${error instanceof Error ? error.message : String(error)}`,
      "runtime",
    );
  }
}
