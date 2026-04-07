import { sha256Text } from "../utils/fs.js";
import { AppError } from "../utils/errors.js";

export interface EmbeddingSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
}

interface EmbeddingApiResponse {
  data: Array<{
    embedding: number[];
    index: number;
  }>;
}

export class EmbeddingClient {
  readonly settings: EmbeddingSettings;

  constructor(settings: EmbeddingSettings) {
    this.settings = settings;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): EmbeddingClient | null {
    const baseUrl = env.EMBEDDING_BASE_URL ?? env.OPENROUTER_BASE_URL;
    const apiKey = env.EMBEDDING_API_KEY ?? env.OPENROUTER_API_KEY;
    const model = env.EMBEDDING_MODEL ?? env.OPENROUTER_EMBEDDING_MODEL;
    const rawDimensions = env.EMBEDDING_DIMENSIONS ?? "384";

    if (!baseUrl || !apiKey || !model) {
      return null;
    }

    const dimensions = Number.parseInt(rawDimensions, 10);
    if (!Number.isFinite(dimensions) || dimensions <= 0) {
      throw new AppError(`Invalid EMBEDDING_DIMENSIONS: ${rawDimensions}`, "config");
    }

    return new EmbeddingClient({
      baseUrl: baseUrl.replace(/\/+$/g, ""),
      apiKey,
      model,
      dimensions,
    });
  }

  get profileHash(): string {
    return sha256Text(
      `${this.settings.baseUrl}:${this.settings.model}:${this.settings.dimensions}`,
    );
  }

  async probe(): Promise<void> {
    await this.embedBatch(["wiki-skill probe"]);
  }

  async embedBatch(inputs: string[]): Promise<number[][]> {
    if (inputs.length === 0) {
      return [];
    }

    const response = await this.requestWithRetry({
      model: this.settings.model,
      input: inputs,
      dimensions: this.settings.dimensions,
    });

    if (!response?.data || !Array.isArray(response.data)) {
      throw new AppError("Embedding API returned an invalid response", "runtime");
    }

    const embeddings = response.data
      .sort((left, right) => left.index - right.index)
      .map((item) => item.embedding);

    if (embeddings.length !== inputs.length) {
      throw new AppError(
        `Embedding API returned ${embeddings.length} vectors for ${inputs.length} inputs`,
        "runtime",
      );
    }

    const normalizedEmbeddings = embeddings.map((embedding) => {
      if (embedding.length === this.settings.dimensions) {
        return embedding;
      }
      if (embedding.length > this.settings.dimensions) {
        return embedding.slice(0, this.settings.dimensions);
      }
      throw new AppError(
        `Embedding dimensions mismatch: expected ${this.settings.dimensions}, got ${embedding.length}`,
        "runtime",
      );
    });

    for (const embedding of normalizedEmbeddings) {
      if (embedding.length !== this.settings.dimensions) {
        throw new AppError(
          `Embedding dimensions mismatch: expected ${this.settings.dimensions}, got ${embedding.length}`,
          "runtime",
        );
      }
    }

    return normalizedEmbeddings;
  }

  async embedAll(inputs: string[], batchSize = 50): Promise<number[][]> {
    const results: number[][] = [];
    for (let index = 0; index < inputs.length; index += batchSize) {
      const batch = inputs.slice(index, index + batchSize);
      const embeddings = await this.embedBatch(batch);
      results.push(...embeddings);
    }
    return results;
  }

  private async requestWithRetry(payload: Record<string, unknown>): Promise<EmbeddingApiResponse> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(`${this.settings.baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.settings.apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(30_000),
        });

        if (!response.ok) {
          const body = await response.text();
          throw new AppError(
            `Embedding API request failed with status ${response.status}`,
            "runtime",
            { body },
          );
        }

        return (await response.json()) as EmbeddingApiResponse;
      } catch (error) {
        lastError = error;
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 250));
        }
      }
    }

    throw lastError instanceof AppError ? lastError : new AppError(String(lastError), "runtime");
  }
}
