/**
 * @file githubOAuth.test.ts
 * Tests for the GitHub admin sign-in helpers.
 *
 * This is an authorisation path, so the tests that matter are the ones that
 * assert something is REFUSED: a partially configured deployment, an empty
 * allowlist, a login that is not on it, and a post-login redirect pointing
 * somewhere other than the admin area.
 *
 * Author: Thomas J McLeish
 * License: MIT
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchGithubLogin,
  generateState,
  getGithubOAuthConfig,
  isAllowedAdmin,
  isGithubOAuthEnabled,
  safeNextPath,
  statesMatch,
} from '../lib/githubOAuth';

function configure(overrides: Record<string, string> = {}): void {
  vi.stubEnv('GITHUB_CLIENT_ID', overrides['GITHUB_CLIENT_ID'] ?? 'client-id');
  vi.stubEnv('GITHUB_CLIENT_SECRET', overrides['GITHUB_CLIENT_SECRET'] ?? 'client-secret');
  vi.stubEnv('GITHUB_ADMIN_LOGINS', overrides['GITHUB_ADMIN_LOGINS'] ?? 'tj60647, Alice');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ── Configuration ─────────────────────────────────────────────────────────────

describe('getGithubOAuthConfig', () => {
  it('reads a complete configuration', () => {
    configure();
    expect(getGithubOAuthConfig()).toEqual({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      admins: ['tj60647', 'alice'],
    });
  });

  it('is disabled when any single piece is missing', () => {
    for (const missing of ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GITHUB_ADMIN_LOGINS']) {
      configure({ [missing]: '' });
      expect(getGithubOAuthConfig(), `${missing} empty should disable sign-in`).toBeNull();
      expect(isGithubOAuthEnabled()).toBe(false);
    }
  });

  it('treats an allowlist of only separators and spaces as empty', () => {
    configure({ GITHUB_ADMIN_LOGINS: ' , ,, ' });
    // The dangerous reading of an empty allowlist is "no restriction". It must
    // mean "nobody", which here means sign-in does not start at all.
    expect(getGithubOAuthConfig()).toBeNull();
  });

  it('ignores surrounding whitespace in credentials', () => {
    configure({ GITHUB_CLIENT_ID: '  client-id  ' });
    expect(getGithubOAuthConfig()?.clientId).toBe('client-id');
  });
});

// ── Allowlist ─────────────────────────────────────────────────────────────────

describe('isAllowedAdmin', () => {
  const config = { clientId: 'x', clientSecret: 'y', admins: ['tj60647', 'alice'] };

  it('admits a listed login regardless of case', () => {
    for (const login of ['tj60647', 'TJ60647', 'Tj60647', ' alice ']) {
      expect(isAllowedAdmin(login, config)).toBe(true);
    }
  });

  it('refuses a login that is not listed', () => {
    for (const login of ['mallory', 'tj6064', 'tj606477', 'alice2', '']) {
      expect(isAllowedAdmin(login, config)).toBe(false);
    }
  });

  it('does not admit on a partial match', () => {
    // A substring check instead of an equality check would let "tj" in.
    expect(isAllowedAdmin('tj', config)).toBe(false);
    expect(isAllowedAdmin('alic', config)).toBe(false);
  });
});

// ── State ─────────────────────────────────────────────────────────────────────

describe('state', () => {
  it('generates a long, unpredictable value', () => {
    const a = generateState();
    const b = generateState();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it('matches only an identical state', () => {
    const s = generateState();
    expect(statesMatch(s, s)).toBe(true);
    expect(statesMatch(s, generateState())).toBe(false);
  });

  it('refuses empty or truncated states', () => {
    const s = generateState();
    expect(statesMatch('', '')).toBe(false);
    expect(statesMatch(s, '')).toBe(false);
    expect(statesMatch(s, s.slice(0, -1))).toBe(false);
  });
});

// ── Post-login redirect ───────────────────────────────────────────────────────

describe('safeNextPath', () => {
  it('keeps a path inside the admin area', () => {
    expect(safeNextPath('/admin')).toBe('/admin');
    expect(safeNextPath('/admin/clients')).toBe('/admin/clients');
    expect(safeNextPath('/admin/usage?tab=tools')).toBe('/admin/usage?tab=tools');
  });

  it('refuses an absolute URL to another origin', () => {
    expect(safeNextPath('https://evil.example/admin')).toBe('/admin');
    expect(safeNextPath('http://evil.example')).toBe('/admin');
  });

  it('refuses a protocol-relative URL', () => {
    // `//evil.example` is a URL, not a path — the classic open-redirect miss
    // that a bare startsWith('/') check waves through.
    expect(safeNextPath('//evil.example')).toBe('/admin');
    expect(safeNextPath('/\\evil.example')).toBe('/admin');
  });

  it('refuses a path that merely begins with the right letters', () => {
    expect(safeNextPath('/administrator-evil')).toBe('/admin');
    expect(safeNextPath('/adminevil')).toBe('/admin');
  });

  it('refuses a path outside the admin area', () => {
    expect(safeNextPath('/chat')).toBe('/admin');
    expect(safeNextPath('/')).toBe('/admin');
  });

  it('falls back when absent', () => {
    expect(safeNextPath(null)).toBe('/admin');
    expect(safeNextPath('')).toBe('/admin');
  });
});

// ── Authorize URL ─────────────────────────────────────────────────────────────

describe('buildAuthorizeUrl', () => {
  it('sends the client id, redirect and state', () => {
    const url = new URL(
      buildAuthorizeUrl({ clientId: 'abc', redirectUri: 'https://x.test/cb', state: 'st' })
    );
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('abc');
    expect(url.searchParams.get('redirect_uri')).toBe('https://x.test/cb');
    expect(url.searchParams.get('state')).toBe('st');
  });

  it('requests only read:user', () => {
    const url = new URL(
      buildAuthorizeUrl({ clientId: 'abc', redirectUri: 'https://x.test/cb', state: 'st' })
    );
    // Anything broader would let this app act on the account when all it needs
    // is to learn which user is signing in.
    expect(url.searchParams.get('scope')).toBe('read:user');
    expect(url.searchParams.get('scope')).not.toContain('repo');
    expect(url.searchParams.get('scope')).not.toContain('org');
  });
});

// ── Token exchange ────────────────────────────────────────────────────────────

describe('exchangeCodeForToken', () => {
  const config = { clientId: 'id', clientSecret: 'secret', admins: ['tj60647'] };
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('returns the access token on success', async () => {
    mockFetch.mockResolvedValueOnce(json({ access_token: 'gho_x' }));
    await expect(
      exchangeCodeForToken({ code: 'c', redirectUri: 'https://x.test/cb', config })
    ).resolves.toBe('gho_x');
  });

  it('returns null when GitHub reports an error with HTTP 200', async () => {
    // GitHub answers a bad code with 200 and an `error` member, so checking
    // res.ok alone would treat a rejected exchange as a successful one.
    mockFetch.mockResolvedValueOnce(json({ error: 'bad_verification_code' }));
    await expect(
      exchangeCodeForToken({ code: 'c', redirectUri: 'https://x.test/cb', config })
    ).resolves.toBeNull();
  });

  it('returns null on a non-2xx response or an unparseable body', async () => {
    mockFetch.mockResolvedValueOnce(json({ access_token: 'x' }, 500));
    await expect(
      exchangeCodeForToken({ code: 'c', redirectUri: 'https://x.test/cb', config })
    ).resolves.toBeNull();

    mockFetch.mockResolvedValueOnce(new Response('<html>', { status: 200 }));
    await expect(
      exchangeCodeForToken({ code: 'c', redirectUri: 'https://x.test/cb', config })
    ).resolves.toBeNull();
  });

  it('bounds the request so a hung GitHub does not hang the callback', async () => {
    mockFetch.mockResolvedValueOnce(json({ access_token: 'x' }));
    await exchangeCodeForToken({ code: 'c', redirectUri: 'https://x.test/cb', config });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

// ── User lookup ───────────────────────────────────────────────────────────────

describe('fetchGithubLogin', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  it('returns the login', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ login: 'tj60647' }), { status: 200 })
    );
    await expect(fetchGithubLogin('tok')).resolves.toBe('tj60647');
  });

  it('sends the token as a bearer credential', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ login: 'tj60647' }), { status: 200 })
    );
    await fetchGithubLogin('tok');
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
  });

  it('returns null when the token is rejected or the body has no login', async () => {
    mockFetch.mockResolvedValueOnce(new Response('{}', { status: 401 }));
    await expect(fetchGithubLogin('tok')).resolves.toBeNull();

    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ login: 42 }), { status: 200 }));
    await expect(fetchGithubLogin('tok')).resolves.toBeNull();

    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    await expect(fetchGithubLogin('tok')).resolves.toBeNull();
  });
});
