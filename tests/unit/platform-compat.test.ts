import { describe, expect, it } from "vitest";

import { resolveBundledSimpleExtensionRelativePath } from "../../src/core/sqlite-extensions.js";

describe("platform compatibility", () => {
  it("maps bundled simple tokenizer assets for supported desktop platforms", () => {
    expect(resolveBundledSimpleExtensionRelativePath("darwin", "arm64")).toBe(
      "assets/sqlite-extensions/darwin-arm64/libsimple.dylib",
    );
    expect(resolveBundledSimpleExtensionRelativePath("darwin", "x64")).toBe(
      "assets/sqlite-extensions/darwin-x64/libsimple.dylib",
    );
    expect(resolveBundledSimpleExtensionRelativePath("linux", "x64")).toBe(
      "assets/sqlite-extensions/linux-x64/libsimple.so",
    );
    expect(resolveBundledSimpleExtensionRelativePath("win32", "x64")).toBe(
      "assets/sqlite-extensions/win32-x64/simple.dll",
    );
  });

  it("fails loudly for unsupported simple tokenizer platform/architecture pairs", () => {
    expect(() => resolveBundledSimpleExtensionRelativePath("linux", "arm64")).toThrow(
      "Bundled simple extension is not available",
    );
  });
});
