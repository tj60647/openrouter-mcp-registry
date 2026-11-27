/**
 * @file github-callback-route.test.ts
 * Tests for the GitHub sign-in callback — the route that decides whether a
 * visitor becomes an admin.
 *
 * The assertions worth having are all negative: a forged or missing state, a
 * GitHub account that is not on the allowlist, and a redirect target smuggled
 * in from outside must every one of them fail to produce a session cookie.
 *
 * Author: Thomas J McLeish
 * License: MIT
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '../app/api/admin/oauth/github/callback/route';
import { OAUTH_STATE_COOKIE } from '../lib/githubOAuth';
import { SESSION_COOKIE, verifySessionToken } from '../lib/session';

const SECRET = 'admin-session-secret-for-tests';
const STATE = 'a'.repeat(64);
const mockFetch = vi.fn();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** GitHub answers the token exchange, then the user lookup. */
function githubAccepts(login: string): void {
  mockFetch
    .mockResolvedValueOnce(json({ access_token: 'gho_test' }))
    .mockResolvedValueOnce(json({ login }));
}

function callback(opts: { state?: string; code?: string; cookie?: string | null; error?: string }) {
  const url = new URL('https://web.test/api/admin/oauth/github/callback');
  if (opts.code !== undefined) url.searchParams.set('code', opts.code);
  if (opts.state !== undefined) url.searchParams.set('state', opts.state);
  if (opts.error) url.searchParams.set('error', opts.error);

  const headers = new Headers();
  if (opts.cookie !== null) {
    headers.set('cookie', `${OAUTH_STATE_COOKIE}=${opts.cookie ?? `${STATE}:/admin`}`);
  }
  return new NextRequest(url, { headers });
}

/** The session cookie the response sets, or undefined when it sets none. */
function sessionCookie(res: Response): string | undefined {
  return (res as unknown as { cookies: { get(n: string): { value: string } | undefined } }).cookies.get(
    SESSION_COOKIE
  )?.value;
}

function location(res: Response): URL {
  return new URL(res.headers.get('location') ?? '', 'https://web.test');
}

describe('GET /api/admin/oauth/github/callback', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    vi.stubEnv('GITHUB_CLIENT_ID', 'client-id');
    vi.stubEnv('GITHUB_CLIENT_SECRET', 'client-secret');
    vi.stubEnv('GITHUB_ADMIN_LOGINS', 'tj60647');
    vi.stubEnv('ADMIN_SESSION_SECRET', SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // ── The happy path ──────────────────────────────────────────────────────────

  it('issues a session for an allowlisted GitHub account', async () => {
    githubAccepts('tj60647');

    const res = await GET(callback({ state: STATE, code: 'code' }));

    expect(res.status).toBe(307);
    expect(location(res).pathname).toBe('/admin');

    const token = sessionCookie(res);
    expect(token).toBeTruthy();
    const payload = await verifySessionToken(token as string, SECRET);
    expect(payload?.username).toBe('tj60647');
  });

  it('signs the session with the admin secret, so the middleware accepts it', async () => {
    githubAccepts('tj60647');

    const res = await GET(callback({ state: STATE, code: 'code' }));

    // Signed with the wrong secret it would be worthless — this is the same
    // check the middleware performs on every /admin request.
    await expect(verifySessionToken(sessionCookie(res) as string, 'a-different-secret')).resolves.toBeNull();
  });

  it('honours the destination captured when sign-in began', async () => {
    githubAccepts('tj60647');

    const res = await GET(callback({ state: STATE, code: 'code', cookie: `${STATE}:/admin/usage` }));

    expect(location(res).pathname).toBe('/admin/usage');
  });

  // ── Refusals ────────────────────────────────────────────────────────────────

  it('refuses a GitHub account that is not on the allowlist', async () => {
    githubAccepts('mallory');

    const res = await GET(callback({ state: STATE, code: 'code' }));

    expect(sessionCookie(res)).toBeFalsy();
    expect(location(res).pathname).toBe('/admin/login');
    expect(location(res).searchParams.get('error')).toBe('denied');
  });

  it('refuses a state that does not match the cookie', async () => {
    githubAccepts('tj60647');

    const res = await GET(callback({ state: 'b'.repeat(64), code: 'code' }));

    // The forged-state request must never reach GitHub, let alone mint a
    // session: this is the CSRF guard on the whole flow.
    expect(sessionCookie(res)).toBeFalsy();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(location(res).searchParams.get('error')).toBe('invalid');
  });

  it('refuses when the state cookie is absent entirely', async () => {
    githubAccepts('tj60647');

    const res = await GET(callback({ state: STATE, code: 'code', cookie: null }));

    expect(sessionCookie(res)).toBeFalsy();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses when no code is returned', async () => {
    const res = await GET(callback({ state: STATE }));

    expect(sessionCookie(res)).toBeFalsy();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses when the user declined on GitHub', async () => {
    const res = await GET(callback({ state: STATE, code: 'code', error: 'access_denied' }));

    expect(sessionCookie(res)).toBeFalsy();
    expect(location(res).searchParams.get('error')).toBe('denied');
  });

  it('refuses when the code exchange fails', async () => {
    mockFetch.mockResolvedValueOnce(json({ error: 'bad_verification_code' }));

    const res = await GET(callback({ state: STATE, code: 'code' }));

    expect(sessionCookie(res)).toBeFalsy();
    expect(location(res).searchParams.get('error')).toBe('invalid');
  });

  it('refuses when GitHub will not identify the user', async () => {
    mockFetch
      .mockResolvedValueOnce(json({ access_token: 'gho_test' }))
      .mockResolvedValueOnce(json({}, 401));

    const res = await GET(callback({ state: STATE, code: 'code' }));

    expect(sessionCookie(res)).toBeFalsy();
  });

  it('refuses when sign-in is not configured', async () => {
    vi.stubEnv('GITHUB_ADMIN_LOGINS', '');
    githubAccepts('tj60647');

    const res = await GET(callback({ state: STATE, code: 'code' }));

    expect(sessionCookie(res)).toBeFalsy();
    expect(location(res).searchParams.get('error')).toBe('unavailable');
  });

  it('refuses when no session secret is configured', async () => {
    vi.stubEnv('ADMIN_SESSION_SECRET', '');
    githubAccepts('tj60647');

    const res = await GET(callback({ state: STATE, code: 'code' }));

    expect(sessionCookie(res)).toBeFalsy();
    expect(location(res).searchParams.get('error')).toBe('unavailable');
  });

  // ── Redirect safety ─────────────────────────────────────────────────────────

  it('does not redirect off-site even if the cookie says to', async () => {
    githubAccepts('tj60647');

    const res = await GET(
      callback({ state: STATE, code: 'code', cookie: `${STATE}://evil.example` })
    );

    // The visitor is signed in, but lands on /admin — not on evil.example with
    // a freshly minted session cookie in flight.
    expect(location(res).host).toBe('web.test');
    expect(location(res).pathname).toBe('/admin');
  });

  it('does not redirect to a non-admin path', async () => {
    githubAccepts('tj60647');

    const res = await GET(callback({ state: STATE, code: 'code', cookie: `${STATE}:/chat` }));

    expect(location(res).pathname).toBe('/admin');
  });

  it('ignores a next value smuggled in through the query string', async () => {
    githubAccepts('tj60647');
    const url = new URL('https://web.test/api/admin/oauth/github/callback');
    url.searchParams.set('code', 'code');
    url.searchParams.set('state', STATE);
    url.searchParams.set('next', '/admin/usage');
    const headers = new Headers({ cookie: `${OAUTH_STATE_COOKIE}=${STATE}:/admin` });

    const res = await GET(new NextRequest(url, { headers }));

    // The destination is read from the cookie set at the start of the flow, so
    // it cannot be swapped after the fact.
    expect(location(res).pathname).toBe('/admin');
  });
});
