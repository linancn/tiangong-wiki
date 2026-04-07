export type ErrorType = "config" | "runtime" | "not_found" | "not_configured";

export class AppError extends Error {
  readonly type: ErrorType;
  readonly exitCode: number;
  readonly details?: unknown;

  constructor(message: string, type: ErrorType = "runtime", details?: unknown) {
    super(message);
    this.name = "AppError";
    this.type = type;
    this.exitCode = type === "config" ? 2 : 1;
    this.details = details;
  }
}

export function asAppError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof Error) {
    return new AppError(error.message, "runtime");
  }

  return new AppError(String(error), "runtime");
}

export function assertCondition(
  condition: unknown,
  message: string,
  type: ErrorType = "runtime",
): asserts condition {
  if (!condition) {
    throw new AppError(message, type);
  }
}
