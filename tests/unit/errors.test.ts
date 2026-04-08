import { describe, expect, it } from "vitest";

import { AppError, asAppError } from "../../src/utils/errors.js";

describe("error normalization", () => {
  it("passes through AppError instances", () => {
    const error = new AppError("boom", "config");
    expect(asAppError(error)).toBe(error);
  });

  it("maps Inquirer ExitPromptError to a user-friendly runtime error", () => {
    const promptAbort = new Error("User force closed the prompt with SIGINT");
    promptAbort.name = "ExitPromptError";

    const appError = asAppError(promptAbort);
    expect(appError).toBeInstanceOf(AppError);
    expect(appError.message).toBe("Prompt cancelled by user.");
    expect(appError.type).toBe("runtime");
    expect(appError.exitCode).toBe(1);
  });

  it("keeps non-prompt errors unchanged apart from AppError wrapping", () => {
    const appError = asAppError(new Error("plain runtime failure"));
    expect(appError.message).toBe("plain runtime failure");
    expect(appError.type).toBe("runtime");
  });
});
