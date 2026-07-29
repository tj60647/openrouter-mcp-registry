/**
 * Fixed-window rate limiter backed by a per-process in-memory map.
 *
 * This is a first-pass brake, NOT the durable limit. On serverless each
 * function instance has its own memory, so a limit here is per warm lambda and
 * empty after a cold start. It is worth keeping because it rejects obvious
 * floods without a round trip, but it must not be relied on alone.
 *
 * apps/web keeps the in-memory version deliberately: it has no runtime database
 * access by design (see "MCP-owned backend env boundary" in the README, and the
 * test asserting apps/web does not require POSTGRES_URL), so it cannot share a
 * Postgres counter the way apps/mcp does. Both surfaces limited here proxy to
 * apps/mcp, and that is where the durable, cross-instance limit is enforced:
 *
 * - /api/admin/login  -> apps/mcp /api/admin/verify-login, limited per username
 * - /api/chat         -> apps/mcp /api/chat
 *
 * Old entries are pruned lazily whenever the map grows beyond PRUNE_THRESHOLD
 * to avoid unbounded memory growth.
 */

interface Entry {
  count: number;
  windowStart: number;
  windowMs: number;
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

  if (!entry || now - entry.windowStart > entry.windowMs) {
    store.set(key, { count: 1, windowStart: now, windowMs });
    maybePrune(now);
    return true;
  }

  if (entry.count >= limit) {
    return false;
  }

  entry.count += 1;
  return true;
}

function maybePrune(now: number): void {
  if (store.size < PRUNE_THRESHOLD) return;
  for (const [key, entry] of store) {
    if (now - entry.windowStart > entry.windowMs) {
      store.delete(key);
    }
  }
}
