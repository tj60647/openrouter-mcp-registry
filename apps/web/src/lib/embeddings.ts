import { db } from '@vercel/postgres';

// Embeddings are generated via OpenRouter, which proxies OpenAI's embedding model.
// This means only OPENROUTER_API_KEY is required — no separate OPENAI_API_KEY needed.
const EMBEDDING_MODEL = 'openai/text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;
const EMBEDDING_API_URL = 'https://openrouter.ai/api/v1/embeddings';
/** Max models to embed per call — keeps cron runs within their time budget. */
const BATCH_SIZE = 50;

/**
 * Generate an embedding vector for a single text string using OpenRouter's
 * openai/text-embedding-3-small model (proxied from OpenAI).
 * Pass your OPENROUTER_API_KEY as the apiKey argument.
 */
export async function generateEmbedding(text: string, apiKey: string): Promise<number[]> {
  const response = await fetch(EMBEDDING_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Embedding API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { data: Array<{ embedding: number[] }> };
  const embedding = data.data[0]?.embedding;
  if (!embedding || embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error('Unexpected embedding response format');
  }
  return embedding;
}

/**
 * Find models that have a description but no embedding yet, generate embeddings
 * in a batch, and persist them.  Returns the number of embeddings generated.
 *
 * Pass your OPENROUTER_API_KEY as the apiKey argument.
 */
export async function generatePendingEmbeddings(apiKey: string): Promise<number> {
  const pending = await db.query<{ id: string; description: string }>(
    `SELECT id, description FROM models
     WHERE description IS NOT NULL AND description_embedding IS NULL
     LIMIT $1`,
    [BATCH_SIZE]
  );

  if (pending.rows.length === 0) return 0;

  let count = 0;
  for (const row of pending.rows) {
    try {
      const embedding = await generateEmbedding(row.description, apiKey);
      // pgvector accepts the array serialised as a Postgres literal: '[0.1,0.2,…]'
      await db.query('UPDATE models SET description_embedding = $1 WHERE id = $2', [
        `[${embedding.join(',')}]`,
        row.id,
      ]);
      count++;
    } catch (err) {
      // Log and continue — this model will be retried on the next sync run.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[embeddings] Failed to generate embedding for model "${row.id}": ${message}`);
    }
  }
  return count;
}
