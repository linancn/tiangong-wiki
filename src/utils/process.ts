import { spawn } from "node:child_process";
import { openSync } from "node:fs";

interface Invocation {
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

export function spawnDetachedCurrentProcess(
  extraArgs: string[],
  options: { env?: NodeJS.ProcessEnv; logFile?: string } = {},
): number | undefined {
  const invocation = getCurrentInvocation();
  const stdio: "ignore" | ["ignore", number, number] = options.logFile
    ? ["ignore", openSync(options.logFile, "a"), openSync(options.logFile, "a")]
    : "ignore";

  const child = spawn(invocation.command, [...invocation.args, ...extraArgs], {
    detached: true,
    stdio,
    env: options.env ?? process.env,
  });
  child.unref();
  return child.pid;
}
