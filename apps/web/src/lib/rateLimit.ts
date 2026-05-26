/**
 * Lightweight sliding-window rate limiter backed by a per-process in-memory map.
 *
 * On serverless (Vercel) each function instance has its own memory space, so
 * limits are enforced per-instance rather than globally. This is intentional:
 * it still provides meaningful protection against obvious per-client abuse
 * without requiring a shared store.
 *
 * Old entries are pruned lazily whenever the map grows beyond PRUNE_THRESHOLD
 * to avoid unbounded memory growth.
 */

interface Entry {
  count: number;
  windowStart: number;
}

const PRUNE_THRESHOLD = 5_000;
const store = new Map<string, Entry>();

export interface RateLimitOptions {
  /** Maximum number of requests allowed within `windowMs`. */
  limit: number;
  /** Sliding window duration in milliseconds. */
  windowMs: number;
}

/**
 * Check and record a rate-limit hit for `key`.
 * Returns `true` when the request is allowed, `false` when the limit is exceeded.
 */
export function checkRateLimit(key: string, { limit, windowMs }: RateLimitOptions): boolean {
  const now = Date.now();
  const entry = store.get(key);

  if (!entry || now - entry.windowStart > windowMs) {
    store.set(key, { count: 1, windowStart: now });
    maybePrune(now, windowMs);
    return true;
  }

  if (entry.count >= limit) {
    return false;
  }

  entry.count += 1;
  return true;
}

function maybePrune(now: number, windowMs: number): void {
  if (store.size < PRUNE_THRESHOLD) return;
  for (const [key, entry] of store) {
    if (now - entry.windowStart > windowMs) {
      store.delete(key);
    }
  }
}
