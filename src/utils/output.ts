import { AppError, asAppError } from "./errors.js";

export type OutputFormat = "json" | "text";

export function writeJson(payload: unknown, stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(`${JSON.stringify(payload, null, 2)}\n`);
}

export function writeText(text: string, stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(text.endsWith("\n") ? text : `${text}\n`);
}

export function handleCliError(error: unknown): never {
  const appError = asAppError(error);
  writeJson(
    {
      error: appError.message,
      type: appError.type,
      ...(appError.details === undefined ? {} : { details: appError.details }),
    },
    process.stderr,
  );
  process.exit(appError.exitCode);
}

export function formatKeyValueLines(values: Record<string, unknown>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}: ${value === undefined ? "" : String(value)}`)
    .join("\n");
}

export function parseOutputFormat(value?: string): OutputFormat {
  if (value === "json") {
    return "json";
  }

  return "text";
}

export function ensureTextOrJson(value: string | undefined): OutputFormat {
  if (value && value !== "text" && value !== "json") {
    throw new AppError(`Unsupported format: ${value}`, "config");
  }

  return parseOutputFormat(value);
}
