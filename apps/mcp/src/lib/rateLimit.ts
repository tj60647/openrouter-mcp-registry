/**
 * Fixed-window rate limiter backed by Postgres.
 *
 * The previous implementation was a module-level Map. On Vercel each function
 * instance has its own memory, so "5 registrations per 15 minutes" was really
 * 5 per 15 minutes *per warm lambda*, and a caller fanning requests across cold
 * starts met an empty map every time. Since this guards dynamic client
 * registration, the token endpoint, the authorize endpoint and admin credential
 * verification, per-instance counting is not a limit so much as a suggestion.
 *
 * The counter now lives in the `rate_limits` table, which apps/mcp already
 * reaches on every one of these paths, so the limit is shared across instances
 * and survives cold starts.
 *
 * NOTE for apps/web: it deliberately has no runtime database access (see the
 * env boundary in README) and keeps a local in-memory limiter as a cheap first
 * pass. Its durable enforcement is the limiter on the apps/mcp endpoint it
 * proxies to.
 */

import { db } from '@vercel/postgres';
import { logger } from '@openrouter-mcp/shared';

export interface RateLimitOptions {
  /** Maximum number of requests allowed within `windowMs`. */
  limit: number;
  /** Window duration in milliseconds. */
  windowMs: number;
}

/** At most one prune per instance per hour; the prune itself is idempotent. */
const PRUNE_INTERVAL_MS = 60 * 60_000;
/** Rows untouched for this long cannot belong to a live window. */
const PRUNE_HORIZON_MS = 24 * 60 * 60_000;
let lastPruneAt = 0;

/**
 * Check and record a rate-limit hit for `key`.
 * Returns `true` when the request is allowed, `false` when the limit is exceeded.
 *
 * Check and increment happen in one statement so concurrent requests on
 * different instances cannot both read the same pre-increment count.
 *
 * Fails **closed**: if the counter cannot be read the request is denied. Every
 * caller of this function is an authentication path that needs the same
 * database anyway, so a failure here means the request was going to fail
 * regardless — and failing open would drop brute-force protection at exactly
 * the moment the database is unhealthy.
 */
export async function checkRateLimit(
  key: string,
  { limit, windowMs }: RateLimitOptions
): Promise<boolean> {
  try {
    const result = await db.query<{ count: string }>(
      `INSERT INTO rate_limits (key, window_start, count)
       VALUES ($1, NOW(), 1)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE
           WHEN rate_limits.window_start < NOW() - ($2::bigint * INTERVAL '1 millisecond')
           THEN 1 ELSE rate_limits.count + 1
         END,
         window_start = CASE
           WHEN rate_limits.window_start < NOW() - ($2::bigint * INTERVAL '1 millisecond')
           THEN NOW() ELSE rate_limits.window_start
         END
       RETURNING count::text AS count`,
      [key, windowMs]
    );

    const count = Number(result.rows[0]?.count);
    if (!Number.isFinite(count)) return false;

    void maybePrune();
    return count <= limit;
  } catch (err) {
    // Narrow carve-out to the one error that is a provisioning gap rather than
    // a failure: the table does not exist because `pnpm db:migrate` has not been
    // run against this database yet. Migrations here are a manual step, so
    // deploying this code first is a realistic mistake — and failing closed on
    // it would take every OAuth endpoint and every MCP tool call down at once,
    // which is far worse than a read-only public registry running briefly
    // without limits. Logged at error level so it cannot pass unnoticed.
    if (isUndefinedTable(err)) {
      logger.error('rate_limits table is missing — rate limiting is DISABLED until migrations run', {
        key,
        remedy: 'pnpm db:migrate',
      });
      return true;
    }
    return false;
  }
}

/** Postgres `undefined_table` (SQLSTATE 42P01), however the driver surfaces it. */
function isUndefinedTable(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  if ((err as { code?: unknown }).code === '42P01') return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && /relation "?rate_limits"? does not exist/i.test(message);
}

/** Best-effort cleanup of windows that expired long ago. Never blocks a caller. */
async function maybePrune(): Promise<void> {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  try {
    await db.query(
      `DELETE FROM rate_limits
       WHERE window_start < NOW() - ($1::bigint * INTERVAL '1 millisecond')`,
      [PRUNE_HORIZON_MS]
    );
  } catch {
    /* pruning is housekeeping — never fail a request over it */
  }
}

/** Test seam: forget when this instance last pruned. */
export function resetPruneScheduleForTests(): void {
  lastPruneAt = 0;
}
