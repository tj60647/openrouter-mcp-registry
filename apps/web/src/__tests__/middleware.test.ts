/**
 * @file middleware.test.ts
 * Tests for the Edge middleware that gates every /admin route. This is the only
 * thing between an anonymous visitor and the admin console, so the tests here
 * exercise the gate end to end with real signed tokens rather than a stubbed
 * verifier: mocking verifySessionToken would prove the middleware calls *a*
 * function, not that a forged or stale cookie is actually rejected. The login
 * page must stay reachable without a session, every other /admin path must
 * bounce to it carrying the original path, and any failure to configure the
 * signing secret must fail closed.
 *
 * Author: Thomas J McLeish
 * License: MIT
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createSessionToken, SESSION_COOKIE, SESSION_TTL_MS } from '../lib/session';
import { middleware } from '../middleware';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SECRET = 'the-real-session-secret';
const ORIGIN = 'https://registry.example.test';

// Deliberately not localhost: the redirect must be built from the incoming
// request's origin, not from a hard-coded host.
function makeRequest(pathname: string, token?: string): NextRequest {
  const headers = new Headers();
  if (token !== undefined) headers.set('cookie', `${SESSION_COOKIE}=${token}`);
  return new NextRequest(new URL(pathname, ORIGIN), { headers });
}

/**
 * Mints a genuinely signed token whose `iat` sits at an arbitrary point in
 * time, so expiry can be exercised without sleeping. Only Date is faked; the
 * Web Crypto signing below settles on the microtask queue, not on a timer.
 */
async function mintTokenIssuedAt(secret: string, username: string, iat: number): Promise<string> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(iat);
  try {
    return await createSessionToken(secret, username);
  } finally {
    vi.useRealTimers();
  }
}

function expectRedirectToLogin(res: Response, fromPath: string): void {
  expect(res.status).toBe(307);
  const location = res.headers.get('location');
  expect(location).not.toBeNull();
  const target = new URL(location as string);
  expect(target.origin).toBe(ORIGIN);
  expect(target.pathname).toBe('/admin/login');
  expect(target.searchParams.get('next')).toBe(fromPath);
}

function expectNotRedirected(res: Response): void {
  expect(res.status).toBe(200);
  expect(res.headers.get('location')).toBeNull();
}

const PROTECTED_PATHS = ['/admin', '/admin/clients', '/admin/usage', '/admin/refresh'];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('admin middleware', () => {
  beforeEach(() => {
    vi.stubEnv('ADMIN_SESSION_SECRET', SECRET);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('lets an anonymous visitor reach the login page, or nobody could ever log in', async () => {
    const res = await middleware(makeRequest('/admin/login'));

    expectNotRedirected(res);
  });

  it('lets the login page load even when the session cookie is unusable', async () => {
    // A stale or corrupted cookie must not lock the user out of the one page
    // that can replace it.
    const res = await middleware(makeRequest('/admin/login', 'v2.garbage.garbage'));

    expectNotRedirected(res);
  });

  it.each(PROTECTED_PATHS)('sends an anonymous visitor at %s to the login page', async (path) => {
    const res = await middleware(makeRequest(path));

    expectRedirectToLogin(res, path);
  });

  it('turns away a cookie holding a value that is not a token at all', async () => {
    const res = await middleware(makeRequest('/admin/clients', 'not-a-token'));

    expectRedirectToLogin(res, '/admin/clients');
  });

  it('turns away a token signed with a different secret', async () => {
    // The token is well-formed, unexpired, and parses cleanly. Only the HMAC is
    // wrong, so admitting it would mean the gate reads the payload without ever
    // checking who signed it.
    const forged = await createSessionToken('an-attackers-own-secret', 'admin');

    const res = await middleware(makeRequest('/admin', forged));

    expectRedirectToLogin(res, '/admin');
  });

  it('turns away a token whose payload was edited after signing', async () => {
    const token = await createSessionToken(SECRET, 'reader');
    const [version, , signature] = token.split('.');
    const tamperedPayload = btoa(JSON.stringify({ username: 'admin', sid: 'x', iat: Date.now() }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const res = await middleware(
      makeRequest('/admin/usage', `${version}.${tamperedPayload}.${signature}`)
    );

    expectRedirectToLogin(res, '/admin/usage');
  });

  it('turns away a correctly signed token once its session has expired', async () => {
    const stale = await mintTokenIssuedAt(SECRET, 'admin', Date.now() - SESSION_TTL_MS - 60_000);

    const res = await middleware(makeRequest('/admin/refresh', stale));

    expectRedirectToLogin(res, '/admin/refresh');
  });

  it.each(PROTECTED_PATHS)('admits a holder of a valid session at %s', async (path) => {
    const token = await createSessionToken(SECRET, 'admin');

    const res = await middleware(makeRequest(path, token));

    expectNotRedirected(res);
  });

  it('does not admit a previously valid session when the signing secret is unset', async () => {
    // A deploy that loses ADMIN_SESSION_SECRET must fail closed. Verification
    // cannot succeed without a secret, so the gate has to refuse rather than
    // skip the check. afterEach's unstubAllEnvs restores the variable.
    const token = await createSessionToken(SECRET, 'admin');
    delete process.env['ADMIN_SESSION_SECRET'];

    const res = await middleware(makeRequest('/admin', token));

    expectRedirectToLogin(res, '/admin');
  });

  it('does not admit a valid session when the signing secret is blank', async () => {
    vi.stubEnv('ADMIN_SESSION_SECRET', '');
    const token = await createSessionToken(SECRET, 'admin');

    const res = await middleware(makeRequest('/admin/clients', token));

    expectRedirectToLogin(res, '/admin/clients');
  });

  it('preserves a nested path and does not drop the visitor at the admin root', async () => {
    const res = await middleware(makeRequest('/admin/clients/abc-123'));

    expectRedirectToLogin(res, '/admin/clients/abc-123');
    const target = new URL(res.headers.get('location') as string);
    expect(target.searchParams.get('next')).not.toBe('/admin');
  });

  it('does not leak the query string of the blocked request into the redirect', async () => {
    // Only the path is round-tripped; forwarding arbitrary query params from an
    // unauthenticated request into the login URL would be an open door for
    // planting values the login page might read back.
    const req = new NextRequest(new URL('/admin/usage?window=90d&debug=1', ORIGIN));

    const res = await middleware(req);

    const target = new URL(res.headers.get('location') as string);
    expect(target.searchParams.get('next')).toBe('/admin/usage');
    expect(target.searchParams.get('window')).toBeNull();
    expect(target.searchParams.get('debug')).toBeNull();
  });
});
