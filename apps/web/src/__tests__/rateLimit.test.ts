/**
 * @file rateLimit.test.ts
 * Tests for the in-memory first-pass limiter in apps/web.
 *
 * apps/web has no runtime database access by design, so this limiter stays
 * in-memory and is explicitly NOT the durable limit — that lives on the apps/mcp
 * endpoint each of these surfaces proxies to. These tests pin the behaviour it
 * does promise, including the per-instance caveat, so nobody mistakes it for a
 * global limit later.
 *
 * Author: Thomas J McLeish
 * License: MIT
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const OPTS = { limit: 3, windowMs: 1_000 };

async function freshLimiter() {
  vi.resetModules();
  return (await import('../lib/rateLimit')).checkRateLimit;
}

describe('checkRateLimit (apps/web, in-memory)', () => {
  let checkRateLimit: Awaited<ReturnType<typeof freshLimiter>>;

  beforeEach(async () => {
    checkRateLimit = await freshLimiter();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows requests up to the limit', () => {
    expect(checkRateLimit('k', OPTS)).toBe(true);
    expect(checkRateLimit('k', OPTS)).toBe(true);
    expect(checkRateLimit('k', OPTS)).toBe(true);
  });

  it('denies the request after the limit is reached', () => {
    for (let i = 0; i < OPTS.limit; i += 1) checkRateLimit('k', OPTS);
    expect(checkRateLimit('k', OPTS)).toBe(false);
  });

  it('keeps denying while the window is open', () => {
    for (let i = 0; i < OPTS.limit + 5; i += 1) checkRateLimit('k', OPTS);
    expect(checkRateLimit('k', OPTS)).toBe(false);
  });

  it('keeps separate keys independent', () => {
    for (let i = 0; i < OPTS.limit; i += 1) checkRateLimit('a', OPTS);
    expect(checkRateLimit('a', OPTS)).toBe(false);
    expect(checkRateLimit('b', OPTS)).toBe(true);
  });

  it('starts a new window once the old one has elapsed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T00:00:00Z'));

    for (let i = 0; i < OPTS.limit; i += 1) checkRateLimit('k', OPTS);
    expect(checkRateLimit('k', OPTS)).toBe(false);

    vi.setSystemTime(new Date('2026-07-29T00:00:02Z'));
    expect(checkRateLimit('k', OPTS)).toBe(true);
  });

  it('is per-process, so a fresh instance starts with an empty budget', async () => {
    for (let i = 0; i < OPTS.limit; i += 1) checkRateLimit('k', OPTS);
    expect(checkRateLimit('k', OPTS)).toBe(false);

    // This is the documented limitation, asserted rather than assumed: on
    // serverless a cold start is a fresh module, and the count is gone. It is
    // why the durable limit has to live behind this one, on the MCP side.
    const afterColdStart = await freshLimiter();
    expect(afterColdStart('k', OPTS)).toBe(true);
  });
});
