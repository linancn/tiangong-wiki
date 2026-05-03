import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupWorkspace, createWorkspace, projectRoot, readFile, type Workspace } from "../helpers.js";

const promptMocks = vi.hoisted(() => ({
  input: vi.fn(),
  password: vi.fn(),
  confirm: vi.fn(),
  select: vi.fn(),
}));

vi.mock("@inquirer/prompts", () => promptMocks);

describe("onboarding inquirer driver", () => {
  let workspace: Workspace;

  beforeEach(() => {
    workspace = createWorkspace();
    promptMocks.input.mockReset();
    promptMocks.password.mockReset();
    promptMocks.confirm.mockReset();
    promptMocks.select.mockReset();
  });

  afterEach(() => {
    cleanupWorkspace(workspace);
  });

  it("uses select/password prompts for TTY setup and still writes the expected env file", async () => {
    const { runSetupWizard } = await import("../../src/core/onboarding.js");

    promptMocks.input.mockImplementation(async (config: { message: string; default?: string }) => {
      if (config.message === "SYNOLOGY_BASE_URL") {
        return "https://nas.example.com:5001";
      }
      if (config.message === "SYNOLOGY_USERNAME") {
        return "tester";
      }
      if (config.message === "VAULT_SYNOLOGY_REMOTE_PATH") {
        return "/vault";
      }
      return config.default ?? "";
    });
    promptMocks.password.mockImplementation(async (config: { message: string }) => {
      if (config.message.startsWith("SYNOLOGY_PASSWORD")) {
        return "secret";
      }
      return "";
    });
    promptMocks.confirm.mockImplementation(async (config: { message: string; default?: boolean }) => {
      if (config.message.startsWith("Install parser skill")) {
        return false;
      }
      return config.default ?? false;
    });
    promptMocks.select.mockImplementation(async (config: { message: string; default?: string }) => {
      if (config.message === "VAULT_SOURCE") {
        return "synology";
      }
      return config.default ?? "content";
    });

    const ttyInput = new PassThrough() as PassThrough & {
      isTTY: boolean;
      setRawMode: (value: boolean) => void;
    };
    ttyInput.isTTY = true;
    ttyInput.setRawMode = () => {};
    const output = new PassThrough();

    const result = await runSetupWizard(
      workspace.env,
      {
        cwd: workspace.root,
        input: ttyInput,
        output,
        packageRoot: projectRoot(),
      },
    );

    expect(result.envFilePath).toBe(path.join(workspace.root, ".wiki.env"));
    expect(promptMocks.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "VAULT_SOURCE",
      }),
      expect.any(Object),
    );
    expect(promptMocks.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "VAULT_HASH_MODE",
      }),
      expect.any(Object),
    );
    expect(promptMocks.password).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("SYNOLOGY_PASSWORD"),
      }),
      expect.any(Object),
    );

    const envFile = readFile(path.join(workspace.root, ".wiki.env"));
    expect(envFile).toContain("VAULT_SOURCE=synology");
    expect(envFile).toContain("VAULT_HASH_MODE=mtime");
    expect(envFile).toContain("SYNOLOGY_PASSWORD=secret");
  });
});
