/**
 * @file people.test.ts
 * A person must sign in with WorkOS, and be on ALLOWED_EMAILS, before an interactive client gets a
 * token; every token says whom it speaks for, and the chat is for people only (TJ, 2026-11-27).
 * Weighted to refusals. The database and WorkOS are stubbed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const store = vi.hoisted(() => ({
  clients: new Map<string, unknown>(),
  codes: new Map<string, Record<string, unknown>>(),
}));

vi.mock('../lib/oauthStore', async () => {
  const { hashAuthorizationCode, generateAuthorizationCode } = await import('../lib/oauth');
  return {
    findClient: vi.fn(async (id: string) => store.clients.get(id) ?? null),
    createAuthorizationCode: vi.fn(async (p: Record<string, unknown>) => {
      const code = (p['code'] as string | undefined) ?? generateAuthorizationCode();
      store.codes.set(hashAuthorizationCode(code), { ...p, expired: false });
      return code;
    }),
    consumeAuthorizationCode: vi.fn(async (code: string) => {
      const key = hashAuthorizationCode(code);
      const row = store.codes.get(key);
      store.codes.delete(key);
      return row ?? null;
    }),
  };
});
vi.mock('../lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true) }));

vi.mock('@ai-sdk/openai', () => ({ createOpenAI: vi.fn(() => ({ chat: vi.fn(() => 'mock-model') })) }));
vi.mock('ai', async (importOriginal) => {
  const mod = await importOriginal<typeof import('ai')>();
  return { ...mod, streamText: vi.fn(() => ({ toUIMessageStreamResponse: () => new Response('streamed') })) };
});
const mcpConnections = vi.hoisted(() => [] as Array<RequestInit | undefined>);
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
    callTool: vi.fn(),
  })),
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn((_url: URL, opts?: { requestInit?: RequestInit }) => {
    mcpConnections.push(opts?.requestInit);
  }),
}));

import * as people from '../lib/people';
import { signAccessToken, signRefreshToken, computePkceChallenge, verifyAccessToken } from '../lib/oauth';
import { callerFromToken } from '../lib/caller';
import { GET as authorize } from '../app/api/oauth/authorize/route';
import { GET as callback } from '../app/api/oauth/workos/callback/route';
import { POST as token } from '../app/api/oauth/token/route';
import { POST as chat } from '../app/api/chat/route';

const ORIGIN = 'https://registry.example';
const CLIENT = {
  clientId: 'claude-client',
  clientSecretHash: null,
  clientName: 'Claude',
  redirectUris: ['https://claude.example/callback'],
  grantTypes: ['authorization_code', 'refresh_token'],
  tokenEndpointAuthMethod: 'none',
  scope: 'mcp:read',
};
const VERIFIER = 'v'.repeat(64);

function setUp(env: Record<string, string> = {}) {
  vi.stubEnv('OAUTH_JWT_SECRET', 'test-jwt-secret-at-least-32-bytes-long!!');
  vi.stubEnv('NEXT_PUBLIC_MCP_URL', ORIGIN);
  vi.stubEnv('WORKOS_CLIENT_ID', 'client_x');
  vi.stubEnv('WORKOS_API_KEY', 'sk_x');
  vi.stubEnv('WORKOS_REDIRECT_URI', `${ORIGIN}/api/oauth/workos/callback`);
  vi.stubEnv('ALLOWED_EMAILS', 'Owner@Example.com, friend@example.com');
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
}

function authorizeRequest(cookie?: string) {
  const q = new URLSearchParams({
    client_id: CLIENT.clientId,
    redirect_uri: CLIENT.redirectUris[0]!,
    response_type: 'code',
    code_challenge: computePkceChallenge(VERIFIER),
    code_challenge_method: 'S256',
    state: 'client-state',
  });
  return new NextRequest(`${ORIGIN}/api/oauth/authorize?${q}`, { headers: cookie ? { cookie } : {} });
}

const tokenPost = (form: Record<string, string>) =>
  new NextRequest(`${ORIGIN}/api/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });

async function personCookie(email: string) {
  return `${people.PERSON_COOKIE}=${encodeURIComponent(await people.signPersonSession(email))}`;
}

beforeEach(() => {
  store.clients.clear();
  store.codes.clear();
  store.clients.set(CLIENT.clientId, CLIENT);
  mcpConnections.length = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('the list and the pieces of a sign-in', () => {
  it('reads ALLOWED_EMAILS without regard to case; an empty list is nobody', () => {
    setUp();
    expect(people.isAllowed('owner@example.com')).toBe(true);
    expect(people.isAllowed('OWNER@EXAMPLE.COM ')).toBe(true);
    expect(people.isAllowed('owner@example.co')).toBe(false);
    expect(people.isAllowed('evil@example.com')).toBe(false);
    vi.stubEnv('ALLOWED_EMAILS', '');
    expect(people.isAllowed('owner@example.com')).toBe(false);
    expect(people.signInMissing()).toEqual(['ALLOWED_EMAILS']);
  });

  it('returns only to the authorization endpoint on this host', () => {
    expect(people.safeReturnTo('/api/oauth/authorize?client_id=x')).toBe('/api/oauth/authorize?client_id=x');
    for (const bad of ['https://evil.example/api/oauth/authorize?x', '//evil.example/api/oauth/authorize?x', '/api/oauth/authorizex?x', '/admin', '/api/oauth/authorize?a\r\nb', 42]) {
      expect(people.safeReturnTo(bad)).toBeNull();
    }
  });

  it('a sign-in state matches only its own nonce', async () => {
    setUp();
    const { nonce, cookie } = await people.newSignInState('/api/oauth/authorize?client_id=x');
    expect(await people.readSignInState(cookie, nonce)).toBe('/api/oauth/authorize?client_id=x');
    expect(await people.readSignInState(cookie, 'another')).toBeNull();
    expect(await people.readSignInState(undefined, nonce)).toBeNull();
    expect(await people.readSignInState(`${cookie}x`, nonce)).toBeNull();
  });

  it('a sealed code carries the person, unreadable to the client it is handed to', async () => {
    setUp();
    const code = await people.sealAuthorizationCode('Owner@Example.com');
    expect(code).not.toMatch(/owner/i);
    expect(await people.personFromAuthorizationCode(code)).toBe('owner@example.com');
    expect(await people.personFromAuthorizationCode('plain-random-code')).toBeNull();
  });

  it('a session cookie stops naming someone taken off the list', async () => {
    setUp();
    const value = await people.signPersonSession('friend@example.com');
    expect(await people.readPersonSession(value)).toBe('friend@example.com');
    vi.stubEnv('ALLOWED_EMAILS', 'owner@example.com');
    expect(await people.readPersonSession(value)).toBeNull();
  });
});

describe('the authorization endpoint', () => {
  it('sends someone not signed in to WorkOS, keeping the request to come back to', async () => {
    setUp();
    const res = await authorize(authorizeRequest());
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get('location')!);
    expect(to.origin + to.pathname).toBe('https://api.workos.com/user_management/authorize');
    expect(to.searchParams.get('provider')).toBe('authkit');
    expect(to.searchParams.get('client_id')).toBe('client_x');
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(new RegExp(`^${people.SIGNIN_STATE_COOKIE}=`));
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(store.codes.size).toBe(0);
  });

  it('issues a code that carries the signed-in person', async () => {
    setUp();
    const res = await authorize(authorizeRequest(await personCookie('owner@example.com')));
    const back = new URL(res.headers.get('location')!);
    expect(back.origin + back.pathname).toBe(CLIENT.redirectUris[0]);
    expect(back.searchParams.get('state')).toBe('client-state');
    expect(await people.personFromAuthorizationCode(back.searchParams.get('code')!)).toBe('owner@example.com');
  });

  it('does not take a sign-in cookie for someone no longer on the list', async () => {
    setUp();
    const cookie = await personCookie('friend@example.com');
    vi.stubEnv('ALLOWED_EMAILS', 'owner@example.com');
    const res = await authorize(authorizeRequest(cookie));
    expect(new URL(res.headers.get('location')!).hostname).toBe('api.workos.com');
  });

  it('refuses every client in production while sign-in is not set up', async () => {
    setUp({ NODE_ENV: 'production', WORKOS_API_KEY: '' });
    const res = await authorize(authorizeRequest(await personCookie('owner@example.com')));
    expect(res.status).toBe(503);
    expect(store.codes.size).toBe(0);
  });

  it('checks the client and its redirect before sending anyone to sign in', async () => {
    setUp();
    store.clients.clear();
    const res = await authorize(authorizeRequest());
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });
});

describe('the WorkOS callback', () => {
  async function started() {
    const res = await authorize(authorizeRequest());
    const nonce = new URL(res.headers.get('location')!).searchParams.get('state')!;
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
    return { nonce, cookie };
  }
  const callbackRequest = (q: Record<string, string>, cookie?: string) =>
    new NextRequest(`${ORIGIN}/api/oauth/workos/callback?${new URLSearchParams(q)}`, { headers: cookie ? { cookie } : {} });
  const workosAnswers = (user: object) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ user }), { status: 200 })));

  it('lets in a verified address on the list and returns to the client’s request', async () => {
    setUp();
    const { nonce, cookie } = await started();
    workosAnswers({ email: 'Owner@Example.com', email_verified: true });
    const res = await callback(callbackRequest({ code: 'workos-code', state: nonce }, cookie));
    expect(res.status).toBe(302);
    const back = new URL(res.headers.get('location')!);
    expect(back.origin).toBe(ORIGIN);
    expect(back.pathname).toBe('/api/oauth/authorize');
    expect(back.searchParams.get('client_id')).toBe(CLIENT.clientId);
    const cookies = res.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith(`${people.PERSON_COOKIE}=`))!;
    expect(session).toMatch(/HttpOnly/);
    const value = decodeURIComponent(session.split(';')[0]!.split('=')[1]!);
    expect(await people.readPersonSession(value)).toBe('owner@example.com');
  });

  it('refuses an address not on the list, an unverified one, a forged state and a missing cookie', async () => {
    setUp();
    const { nonce, cookie } = await started();
    workosAnswers({ email: 'stranger@example.com', email_verified: true });
    expect((await callback(callbackRequest({ code: 'c', state: nonce }, cookie))).status).toBe(403);
    workosAnswers({ email: 'owner@example.com', email_verified: false });
    expect((await callback(callbackRequest({ code: 'c', state: nonce }, cookie))).status).toBe(403);
    workosAnswers({ email: 'owner@example.com', email_verified: true });
    expect((await callback(callbackRequest({ code: 'c', state: 'forged' }, cookie))).status).toBe(400);
    expect((await callback(callbackRequest({ code: 'c', state: nonce }))).status).toBe(400);
  });

  it('says so when WorkOS cannot be reached, and sets no session', async () => {
    setUp();
    const { nonce, cookie } = await started();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const res = await callback(callbackRequest({ code: 'c', state: nonce }, cookie));
    expect(res.status).toBe(502);
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${people.PERSON_COOKIE}=`))).toBe(false);
  });
});

describe('the token endpoint', () => {
  async function codeFor(email: string) {
    const res = await authorize(authorizeRequest(await personCookie(email)));
    return new URL(res.headers.get('location')!).searchParams.get('code')!;
  }
  const exchange = (code: string) =>
    token(tokenPost({ grant_type: 'authorization_code', client_id: CLIENT.clientId, code, redirect_uri: CLIENT.redirectUris[0]!, code_verifier: VERIFIER }));

  it('puts the person into the access and refresh tokens, and keeps them on refresh', async () => {
    setUp();
    const res = await exchange(await codeFor('owner@example.com'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string; refresh_token: string };
    expect((await verifyAccessToken(body.access_token)).person).toBe('owner@example.com');
    const again = await token(tokenPost({ grant_type: 'refresh_token', client_id: CLIENT.clientId, refresh_token: body.refresh_token }));
    expect(again.status).toBe(200);
    expect((await verifyAccessToken(((await again.json()) as { access_token: string }).access_token)).person).toBe('owner@example.com');
  });

  it('refuses to refresh for someone taken off the list', async () => {
    setUp();
    const refresh = await signRefreshToken(CLIENT.clientId, 'mcp:read', { person: 'friend@example.com' });
    vi.stubEnv('ALLOWED_EMAILS', 'owner@example.com');
    const res = await token(tokenPost({ grant_type: 'refresh_token', client_id: CLIENT.clientId, refresh_token: refresh }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('in production, refuses a refresh token from before sign-in was required', async () => {
    setUp({ NODE_ENV: 'production' });
    const old = await signRefreshToken(CLIENT.clientId, 'mcp:read');
    const res = await token(tokenPost({ grant_type: 'refresh_token', client_id: CLIENT.clientId, refresh_token: old }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error_description: string }).error_description).toMatch(/sign-in is required/);
  });
});

describe('who may call', () => {
  it('a person on the list, or a service client; in production, nothing else', async () => {
    setUp({ NODE_ENV: 'production' });
    expect((await callerFromToken(await signAccessToken('c', 'mcp:read', { person: 'owner@example.com' })))?.person).toBe('owner@example.com');
    expect((await callerFromToken(await signAccessToken('svc', 'mcp:read', { grant: 'client_credentials' })))?.service).toBe(true);
    expect(await callerFromToken(await signAccessToken('c', 'mcp:read', { person: 'stranger@example.com' }))).toBeNull();
    expect(await callerFromToken(await signAccessToken('c', 'mcp:read'))).toBeNull();
    expect(await callerFromToken(undefined)).toBeNull();
    expect(await callerFromToken('not-a-jwt')).toBeNull();
  });
});

describe('the chat, which spends money', () => {
  const chatPost = (bearer?: string) =>
    new Request(`${ORIGIN}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify({ messages: [], model: 'anthropic/claude-opus-5.5' }),
    });

  it('answers a person on the list, and reaches the registry with their own token', async () => {
    setUp({ NODE_ENV: 'production', OPENROUTER_API_KEY: 'k' });
    const personal = await signAccessToken('demo-client', 'mcp:read', { person: 'owner@example.com' });
    const res = await chat(chatPost(personal));
    expect(res.status).toBe(200);
    expect(mcpConnections[0]?.headers).toEqual({ Authorization: `Bearer ${personal}` });
  });

  it('refuses a service client, someone off the list, and no token at all', async () => {
    setUp({ NODE_ENV: 'production', OPENROUTER_API_KEY: 'k' });
    expect((await chat(chatPost(await signAccessToken('svc', 'mcp:read', { grant: 'client_credentials' })))).status).toBe(403);
    expect((await chat(chatPost(await signAccessToken('c', 'mcp:read', { person: 'stranger@example.com' })))).status).toBe(401);
    expect((await chat(chatPost())).status).toBe(401);
    expect(mcpConnections).toHaveLength(0);
  });
});
