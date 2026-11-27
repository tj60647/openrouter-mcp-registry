/**
 * The chat demo signs a visitor in through apps/mcp as any other client does: authorization code +
 * PKCE, its own client id, the visitor's own tokens in an encrypted cookie (lib/chatSignIn.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import * as chat from '../lib/chatSignIn';

const SECRET = 'test-chat-session-secret-at-least-32-chars';
const ORIGIN = 'https://registry.example';

beforeEach(() => {
  vi.stubEnv('MCP_URL', 'https://mcp.example');
  vi.stubEnv('MCP_OAUTH_CLIENT_ID', 'demo-public-client');
  vi.stubEnv('CHAT_SESSION_SECRET', SECRET);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('lib/chatSignIn', () => {
  it('names what is missing, and is not set up with a short secret', () => {
    vi.stubEnv('CHAT_SESSION_SECRET', 'short');
    vi.stubEnv('MCP_OAUTH_CLIENT_ID', '');
    expect(chat.chatSignInSettings()).toEqual({ missing: ['MCP_OAUTH_CLIENT_ID', 'CHAT_SESSION_SECRET'] });
  });

  it('seals so that only this app can open, and a tampered or other-purpose seal opens to nothing', () => {
    const sealed = chat.seal(SECRET, 'tokens', { access: 'a' });
    expect(sealed).not.toContain('access');
    expect(chat.open(SECRET, 'tokens', sealed)).toEqual({ access: 'a' });
    expect(chat.open(SECRET, 'signin', sealed)).toBeNull();
    expect(chat.open('another-secret-that-is-also-32-chars-long', 'tokens', sealed)).toBeNull();
    expect(chat.open(SECRET, 'tokens', sealed.slice(0, -2) + 'AA')).toBeNull();
    expect(chat.open(SECRET, 'tokens', 'not.a.seal')).toBeNull();
  });

  it('returns only to a page of this app', () => {
    expect(chat.safeReturnTo('/demo?x=1')).toBe('/demo?x=1');
    for (const bad of ['https://evil.example', '//evil.example', '/api/sign-in/out', '\\evil', null, undefined]) {
      expect(chat.safeReturnTo(bad as string)).toBe('/demo');
    }
  });

  it('starts at apps/mcp’s authorization endpoint with PKCE, its client id and this host’s callback', () => {
    const s = chat.chatSignInSettings() as chat.ChatSignInSettings;
    const { location, cookie } = chat.startSignIn(s, ORIGIN, '/demo');
    const url = new URL(location);
    expect(url.origin + url.pathname).toBe('https://mcp.example/api/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('demo-public-client');
    expect(url.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/sign-in/callback`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(cookie).toMatch(/HttpOnly/);
    const value = cookie.split(';')[0]!.split('=')[1]!;
    const remembered = chat.readSignIn(s, value, url.searchParams.get('state'));
    expect(remembered?.ret).toBe('/demo');
    expect(chat.readSignIn(s, value, 'forged')).toBeNull();
  });

  it('reads who signed in from the token, for display only', () => {
    const payload = Buffer.from(JSON.stringify({ person: 'owner@example.com' })).toString('base64url');
    expect(chat.personOf(`h.${payload}.s`)).toBe('owner@example.com');
    expect(chat.personOf('garbage')).toBeNull();
  });
});

describe('/api/sign-in', () => {
  async function started() {
    const { GET } = await import('../app/api/sign-in/start/route');
    const res = await GET(new NextRequest(`${ORIGIN}/api/sign-in/start?return=/demo`));
    const state = new URL(res.headers.get('location')!).searchParams.get('state')!;
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    return { state, cookie };
  }

  it('start says so when sign-in is not set up', async () => {
    vi.stubEnv('MCP_OAUTH_CLIENT_ID', '');
    const { GET } = await import('../app/api/sign-in/start/route');
    expect((await GET(new NextRequest(`${ORIGIN}/api/sign-in/start`))).status).toBe(503);
  });

  it('callback exchanges the code with the verifier, keeps the visitor’s tokens and goes back', async () => {
    const { state, cookie } = await started();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ access_token: 'visitor-jwt', refresh_token: 'r', expires_in: 3600 })));
    const { GET } = await import('../app/api/sign-in/callback/route');
    const res = await GET(new NextRequest(`${ORIGIN}/api/sign-in/callback?code=abc&state=${state}`, { headers: { cookie } }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/demo`);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('https://mcp.example/api/oauth/token');
    const form = new URLSearchParams(String((init as RequestInit).body));
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('client_id')).toBe('demo-public-client');
    expect(form.get('code_verifier')).toBeTruthy();
    expect(form.get('redirect_uri')).toBe(`${ORIGIN}/api/sign-in/callback`);
    const kept = res.headers.getSetCookie().find((c) => c.startsWith(`${chat.CHAT_COOKIE}=`))!;
    expect(chat.open<{ access: string }>(SECRET, 'tokens', kept.split(';')[0]!.split('=')[1])?.access).toBe('visitor-jwt');
  });

  it('callback refuses a forged state and a missing cookie, and keeps nothing when apps/mcp refuses', async () => {
    const { state, cookie } = await started();
    const { GET } = await import('../app/api/sign-in/callback/route');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'invalid_grant' }, { status: 400 })));
    for (const req of [
      new NextRequest(`${ORIGIN}/api/sign-in/callback?code=abc&state=forged`, { headers: { cookie } }),
      new NextRequest(`${ORIGIN}/api/sign-in/callback?code=abc&state=${state}`),
      new NextRequest(`${ORIGIN}/api/sign-in/callback?code=abc&state=${state}`, { headers: { cookie } }),
    ]) {
      const res = await GET(req);
      expect(res.status).toBe(302);
      expect(new URL(res.headers.get('location')!).searchParams.get('sign_in')).toBeTruthy();
      expect(res.headers.getSetCookie().some((c) => c.startsWith(`${chat.CHAT_COOKIE}=`))).toBe(false);
    }
  });

  it('session says who is signed in; sign-out forgets them', async () => {
    const payload = Buffer.from(JSON.stringify({ person: 'owner@example.com' })).toString('base64url');
    const sealed = chat.seal(SECRET, 'tokens', { access: `h.${payload}.s`, refresh: null, expiresAt: Date.now() + 3_600_000 });
    const { GET } = await import('../app/api/sign-in/session/route');
    const res = await GET(new NextRequest(`${ORIGIN}/api/sign-in/session`, { headers: { cookie: `${chat.CHAT_COOKIE}=${sealed}` } }));
    expect(await res.json()).toEqual({ configured: true, signedIn: true, person: 'owner@example.com' });
    const out = await (await import('../app/api/sign-in/out/route')).POST();
    expect(out.headers.get('set-cookie')).toMatch(new RegExp(`^${chat.CHAT_COOKIE}=; .*Max-Age=0`));
  });
});
