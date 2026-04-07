import { describe, expect, it } from "vitest";

import { normalizeFtsQuery, segmentForFts } from "../../src/utils/segmenter.js";

describe("segmenter", () => {
  it("segments Chinese text into searchable tokens for FTS", () => {
    expect(segmentForFts("项目开发环境配置")).toBe("项目 开发 环境 配置");
    expect(segmentForFts("开发 AI 能力")).toBe("开发 AI 能力");
  });

  it("keeps non-CJK queries stable while normalizing CJK queries", () => {
    expect(normalizeFtsQuery("classification")).toBe("classification");
    expect(normalizeFtsQuery("AI")).toBe("AI");
    expect(normalizeFtsQuery("开发环境")).toBe("开发 环境");
    expect(normalizeFtsQuery("\"开发环境\" OR AI")).toBe("\"开发 环境\" OR AI");
  });
});
