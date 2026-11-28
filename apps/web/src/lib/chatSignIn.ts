/**
 * The chat demo as an ordinary client of the MCP server (TJ, 2026-11-27: "The demo should require
 * workos … The demo should register like any other client").
 *
 * It is registered with apps/mcp as a public client (authorization code + PKCE, no secret), and its
 * client id is MCP_OAUTH_CLIENT_ID. A visitor signs in through apps/mcp's authorization endpoint,
 * which sends them to WorkOS and lets in only the people on its ALLOWED_EMAILS. The tokens apps/mcp
 * issues are the visitor's own: they are kept in an encrypted, HttpOnly cookie, sent with each chat
 * message, and refreshed shortly before they expire. Nothing is stored on the server.
 *
 * Environment:
 *   MCP_OAUTH_CLIENT_ID   the client id apps/mcp's registration endpoint gave this app
 *   CHAT_SESSION_SECRET   32 characters or more; the cookies are encrypted with keys derived from it
 *   MCP_URL / NEXT_PUBLIC_MCP_URL   where apps/mcp is (lib/mcpAuth.ts)
 *
 * The redirect URI is this host's /api/sign-in/callback; register exactly that with apps/mcp.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { getMcpBaseUrl } from './mcpAuth';

export const CHAT_COOKIE = 'registry_chat';
export const SIGNIN_COOKIE = 'registry_chat_signin';
export const CALLBACK_PATH = '/api/sign-in/callback';
const SIGNIN_SECONDS = 10 * 60;
const CHAT_COOKIE_SECONDS = 30 * 24 * 60 * 60;
/** Refresh this long before the access token expires, so a message never carries a dead one. */
const REFRESH_MARGIN_MS = 60_000;

type Env = Record<string, string | undefined>;

export interface ChatSignInSettings {
  clientId: string;
  secret: string;
  mcpUrl: string;
}

/** The settings, or the names of the missing ones. */
export function chatSignInSettings(env: Env = process.env): ChatSignInSettings | { missing: string[] } {
  const clientId = env['MCP_OAUTH_CLIENT_ID']?.trim();
  const secret = env['CHAT_SESSION_SECRET'] ?? '';
  const mcpUrl = (env['MCP_URL'] ?? env['NEXT_PUBLIC_MCP_URL'])?.replace(/\/+$/, '');
  const missing: string[] = [];
  if (!clientId) missing.push('MCP_OAUTH_CLIENT_ID');
  if (secret.length < 32) missing.push('CHAT_SESSION_SECRET');
  if (!mcpUrl) missing.push('MCP_URL');
  if (missing.length > 0 || !clientId || !mcpUrl) return { missing };
  return { clientId, secret, mcpUrl };
}

export const isConfigured = (s: ChatSignInSettings | { missing: string[] }): s is ChatSignInSettings => !('missing' in s);

// ── Sealing: AES-256-GCM, a key per purpose derived from CHAT_SESSION_SECRET ──

function keyFor(secret: string, purpose: string): Buffer {
  return createHash('sha256').update(`registry-chat/${purpose}\n${secret}`).digest();
}

export function seal(secret: string, purpose: string, value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(secret, purpose), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
}

export function open<T>(secret: string, purpose: string, sealed: string | undefined): T | null {
  if (!sealed) return null;
  const parts = sealed.split('.');
  if (parts.length !== 3) return null;
  try {
    const [iv, tag, body] = parts.map((p) => Buffer.from(p, 'base64url')) as [Buffer, Buffer, Buffer];
    const decipher = createDecipheriv('aes-256-gcm', keyFor(secret, purpose), iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')) as T;
  } catch {
    return null;
  }
}

// ── Where a sign-in may return to ──

/** A page of this app to return to after signing in: a path, never a URL. */
export function safeReturnTo(value: string | null | undefined): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\r\n]/.test(value) || value.startsWith('/api/')) {
    return '/demo';
  }
  return value.slice(0, 500);
}

// ── PKCE (RFC 7636) ──

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

// ── The sign-in round trip ──

interface SignInState {
  state: string;
  verifier: string;
  ret: string;
  exp: number;
}

/** The address to send the visitor to, and the cookie that remembers this attempt. */
export function startSignIn(s: ChatSignInSettings, origin: string, returnTo: string): { location: string; cookie: string } {
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(16).toString('base64url');
  const url = new URL(`${s.mcpUrl}/api/oauth/authorize`);
  url.search = new URLSearchParams({
    client_id: s.clientId,
    redirect_uri: `${origin}${CALLBACK_PATH}`,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'mcp:read',
    state,
  }).toString();
  const value = seal(s.secret, 'signin', { state, verifier, ret: safeReturnTo(returnTo), exp: Date.now() + SIGNIN_SECONDS * 1000 } satisfies SignInState);
  return { location: url.toString(), cookie: cookie(SIGNIN_COOKIE, value, SIGNIN_SECONDS, '/api/sign-in') };
}

/** The attempt the cookie remembers, if its state is the one that came back and it has not expired. */
export function readSignIn(s: ChatSignInSettings, cookieValue: string | undefined, state: string | null): SignInState | null {
  const found = open<SignInState>(s.secret, 'signin', cookieValue);
  if (!found || !state || found.state !== state || found.exp < Date.now()) return null;
  return found;
}

// ── Tokens ──

export interface ChatTokens {
  access: string;
  refresh: string | null;
  /** Unix ms. */
  expiresAt: number;
}

interface TokenAnswer {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

async function askToken(s: ChatSignInSettings, form: Record<string, string>, fetchImpl: typeof fetch): Promise<ChatTokens> {
  const res = await fetchImpl(`${s.mcpUrl}/api/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: s.clientId, ...form }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`token_refused_${res.status}`);
  const body = (await res.json()) as TokenAnswer;
  if (!body.access_token) throw new Error('token_missing');
  return {
    access: body.access_token,
    refresh: body.refresh_token ?? null,
    expiresAt: Date.now() + Math.min(body.expires_in ?? 3600, 3600) * 1000,
  };
}

export function exchangeCode(s: ChatSignInSettings, origin: string, code: string, verifier: string, fetchImpl: typeof fetch = fetch): Promise<ChatTokens> {
  return askToken(s, { grant_type: 'authorization_code', code, redirect_uri: `${origin}${CALLBACK_PATH}`, code_verifier: verifier }, fetchImpl);
}

export const sealTokens = (s: ChatSignInSettings, tokens: ChatTokens) =>
  cookie(CHAT_COOKIE, seal(s.secret, 'tokens', tokens), CHAT_COOKIE_SECONDS, '/api');

export const clearChatCookie = () => cookie(CHAT_COOKIE, '', 0, '/api');
export const clearSignInCookie = () => cookie(SIGNIN_COOKIE, '', 0, '/api/sign-in');

/**
 * The visitor's access token, refreshed when it is about to expire. Returns the token and, when it
 * was refreshed, the cookie to set; null when there is no sign-in, or the refresh was refused (the
 * visitor was taken off the list, or signed in before sign-in was required): sign in again.
 */
export async function currentAccessToken(
  s: ChatSignInSettings,
  cookieValue: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<{ access: string; setCookie?: string } | null> {
  const tokens = open<ChatTokens>(s.secret, 'tokens', cookieValue);
  if (!tokens) return null;
  if (tokens.expiresAt - REFRESH_MARGIN_MS > Date.now()) return { access: tokens.access };
  if (!tokens.refresh) return null;
  try {
    const fresh = await askToken(s, { grant_type: 'refresh_token', refresh_token: tokens.refresh }, fetchImpl);
    const kept: ChatTokens = { ...fresh, refresh: fresh.refresh ?? tokens.refresh };
    return { access: kept.access, setCookie: sealTokens(s, kept) };
  } catch {
    return null;
  }
}

/** The signed-in person's email, read from the token apps/mcp issued (shown, never trusted). */
export function personOf(access: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(access.split('.')[1] ?? '', 'base64url').toString('utf8')) as { person?: unknown };
    return typeof payload.person === 'string' ? payload.person : null;
  } catch {
    return null;
  }
}

// ── Cookies ──

export function cookieFrom(header: string | null, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** HttpOnly, Secure (except on plain-http localhost), SameSite=Lax: the sign-in returns by a cross-site navigation. */
function cookie(name: string, value: string, maxAge: number, path: string): string {
  const secure = process.env['NODE_ENV'] === 'production' ? '; Secure' : '';
  return `${name}=${value}; Path=${path}; HttpOnly${secure}; SameSite=Lax; Max-Age=${maxAge}`;
}

export { getMcpBaseUrl };
