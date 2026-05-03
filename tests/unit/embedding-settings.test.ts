import { describe, expect, it } from "vitest";

import { DEFAULT_EMBEDDING_DIMENSIONS, EmbeddingClient } from "../../src/core/embedding.js";
import { getEmbeddingDimensionFromEnv } from "../../src/core/runtime.js";

describe("embedding settings", () => {
  it("defaults OpenAI text-embedding-3-small compatible dimensions to 1536", () => {
    const client = EmbeddingClient.fromEnv({
      EMBEDDING_BASE_URL: "https://api.openai.com/v1",
      EMBEDDING_API_KEY: "test-key",
      EMBEDDING_MODEL: "text-embedding-3-small",
    });

    expect(DEFAULT_EMBEDDING_DIMENSIONS).toBe(1536);
    expect(client?.settings.dimensions).toBe(1536);
    expect(getEmbeddingDimensionFromEnv({})).toBe(1536);
  });

  it("still honors explicit lower-dimensional embedding configuration", () => {
    const client = EmbeddingClient.fromEnv({
      EMBEDDING_BASE_URL: "https://api.openai.com/v1",
      EMBEDDING_API_KEY: "test-key",
      EMBEDDING_MODEL: "text-embedding-3-small",
      EMBEDDING_DIMENSIONS: "384",
    });

    expect(client?.settings.dimensions).toBe(384);
  });
});
