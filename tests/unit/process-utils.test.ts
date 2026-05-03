import { describe, expect, it } from "vitest";

import { buildDetachedSpawnOptions, buildOpenTargetInvocation } from "../../src/utils/process.js";

describe("process utilities", () => {
  it("hides spawned windows for detached background processes", () => {
    const options = buildDetachedSpawnOptions({
      env: {
        PATH: "/bin",
      },
    });

    expect(options.detached).toBe(true);
    expect(options.stdio).toBe("ignore");
    expect(options.windowsHide).toBe(true);
    expect(options.env.PATH).toBe("/bin");
  });

  it("uses platform-specific open commands without shell interpolation", () => {
    expect(buildOpenTargetInvocation("http://127.0.0.1:3000", "darwin")).toEqual({
      command: "open",
      args: ["http://127.0.0.1:3000"],
    });
    expect(buildOpenTargetInvocation("http://127.0.0.1:3000", "linux")).toEqual({
      command: "xdg-open",
      args: ["http://127.0.0.1:3000"],
    });
    expect(buildOpenTargetInvocation("http://127.0.0.1:3000", "win32")).toEqual({
      command: "cmd",
      args: ["/c", "start", "", "http://127.0.0.1:3000"],
    });
  });
});
