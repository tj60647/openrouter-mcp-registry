/**
 * People: who may connect to this registry as themselves.
 *
 * An interactive client (Claude, Cursor, the reference web app's chat) gets a token only after the
 * person behind it signs in with WorkOS AuthKit, with a verified email on ALLOWED_EMAILS. A token
 * from that sign-in carries the person's email (the `person` claim), which every use of the token
 * checks against the list again, so taking an address off the list ends that person's access at
 * once rather than when their refresh token expires.
 *
 * Service clients (client_credentials) are machines, not people: they carry no person and are
 * marked `grant: client_credentials` instead.
 *
 * Environment:
 *   WORKOS_CLIENT_ID      client_… of the WorkOS application (the AuthKit project people sign in to)
 *   WORKOS_API_KEY        sk_… (server only; sent to WorkOS as client_secret, never logged)
 *   WORKOS_REDIRECT_URI   https://<this host>/api/oauth/workos/callback, as registered in WorkOS
 *   ALLOWED_EMAILS        the addresses that may sign in, separated by commas or spaces
 *   OAUTH_JWT_SECRET      already required for tokens; the cookies and sealed codes here derive their
 *                         own keys from it, one per purpose
 *
 * With any of these missing, sign-in is not set up and the authorization endpoint refuses (fails
 * closed). The token and the WorkOS exchange are the only calls this module makes.
 */

import { SignJWT, jwtVerify, EncryptJWT, jwtDecrypt } from 'jose';
import { createHash, randomBytes } from 'node:crypto';

const WORKOS_API = 'https://api.workos.com/user_management';

export const PERSON_COOKIE = 'registry_person';
export const SIGNIN_STATE_COOKIE = 'registry_signin_state';
export const PERSON_SESSION_SECONDS = 12 * 60 * 60;
export const SIGNIN_STATE_SECONDS = 10 * 60;
/** The only place a sign-in may return to: the authorization endpoint, with its query. */
export const AUTHORIZE_PATH = '/api/oauth/authorize';

type Env = Record<string, string | undefined>;

/** The addresses on ALLOWED_EMAILS, lower-cased. Empty means nobody, never everybody. */
export function allowedEmails(env: Env = process.env): Set<string> {
  return new Set(
    (env['ALLOWED_EMAILS'] ?? '')
      .split(/[\s,]+/)
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.includes('@')),
  );
}

export function isAllowed(email: string | undefined | null, env: Env = process.env): boolean {
  return typeof email === 'string' && allowedEmails(env).has(email.trim().toLowerCase());
}

export interface WorkosSettings {
  clientId: string;
  apiKey: string;
  redirectUri: string;
}

/** WorkOS's settings, or null when any is missing. */
export function workosSettings(env: Env = process.env): WorkosSettings | null {
  const clientId = env['WORKOS_CLIENT_ID']?.trim();
  const apiKey = env['WORKOS_API_KEY']?.trim();
  const redirectUri = env['WORKOS_REDIRECT_URI']?.trim();
  if (!clientId || !apiKey || !redirectUri) return null;
  return { clientId, apiKey, redirectUri };
}

/** Everything sign-in needs: WorkOS, a list with someone on it, and the secret the cookies derive from. */
export function signInMissing(env: Env = process.env): string[] {
  const missing: string[] = [];
  if (!env['WORKOS_CLIENT_ID']?.trim()) missing.push('WORKOS_CLIENT_ID');
  if (!env['WORKOS_API_KEY']?.trim()) missing.push('WORKOS_API_KEY');
  if (!env['WORKOS_REDIRECT_URI']?.trim()) missing.push('WORKOS_REDIRECT_URI');
  if (allowedEmails(env).size === 0) missing.push('ALLOWED_EMAILS');
  if (!env['OAUTH_JWT_SECRET']) missing.push('OAUTH_JWT_SECRET');
  return missing;
}

/** AuthKit's hosted sign-in, returning to WORKOS_REDIRECT_URI with `state`. */
export function authorizeUrl(settings: WorkosSettings, state: string): string {
  const url = new URL(`${WORKOS_API}/authorize`);
  url.search = new URLSearchParams({
    client_id: settings.clientId,
    redirect_uri: settings.redirectUri,
    response_type: 'code',
    provider: 'authkit',
    state,
  }).toString();
  return url.toString();
}

/** Exchange AuthKit's code for the signed-in person. Throws on any failure. */
export async function exchangeCode(
  settings: WorkosSettings,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ email: string; emailVerified: boolean }> {
  let res: Response;
  try {
    res = await fetchImpl(`${WORKOS_API}/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: settings.clientId,
        client_secret: settings.apiKey,
        grant_type: 'authorization_code',
        code,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error('workos_unreachable');
  }
  if (!res.ok) throw new Error(`workos_exchange_failed_${res.status}`);
  const body = (await res.json().catch(() => ({}))) as { user?: { email?: unknown; email_verified?: unknown } };
  const user = body.user;
  if (!user || typeof user.email !== 'string') throw new Error('workos_no_user');
  return { email: user.email.trim().toLowerCase(), emailVerified: user.email_verified === true };
}

// ── Keys, one per purpose, derived from OAUTH_JWT_SECRET ──────────────────────

function keyFor(purpose: string, env: Env = process.env): Uint8Array {
  const secret = env['OAUTH_JWT_SECRET'];
  if (!secret) throw new Error('OAUTH_JWT_SECRET is not configured');
  return new Uint8Array(createHash('sha256').update(`registry-people/${purpose}\n${secret}`).digest());
}

// ── The person's sign-in, kept between the AuthKit round trip and the authorize step ──

/** A signed cookie value naming the signed-in person for PERSON_SESSION_SECONDS. */
export async function signPersonSession(email: string): Promise<string> {
  return new SignJWT({ email: email.toLowerCase() })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${PERSON_SESSION_SECONDS}s`)
    .sign(keyFor('person'));
}

/** The person a session cookie names, if it is valid and they are still on the list; else null. */
export async function readPersonSession(value: string | undefined): Promise<string | null> {
  if (!value) return null;
  try {
    const { payload } = await jwtVerify(value, keyFor('person'), { algorithms: ['HS256'] });
    const email = typeof payload['email'] === 'string' ? payload['email'] : null;
    return email && isAllowed(email) ? email : null;
  } catch {
    return null;
  }
}

/**
 * Only the authorization endpoint, on this host, may be returned to: a path, never a URL, that
 * starts with AUTHORIZE_PATH followed by its query.
 */
export function safeReturnTo(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4000) return null;
  if (!value.startsWith(`${AUTHORIZE_PATH}?`)) return null;
  if (/[\r\n\\]/.test(value)) return null;
  return value;
}

/** The state for one AuthKit round trip: a random nonce, sent as `state` and kept in a signed cookie with where to return. */
export async function newSignInState(returnTo: string): Promise<{ nonce: string; cookie: string }> {
  const nonce = randomBytes(16).toString('base64url');
  const cookie = await new SignJWT({ nonce, ret: returnTo })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SIGNIN_STATE_SECONDS}s`)
    .sign(keyFor('signin-state'));
  return { nonce, cookie };
}

/** Where to return, when the cookie is valid and its nonce is the one AuthKit sent back; else null. */
export async function readSignInState(cookie: string | undefined, nonce: string | null): Promise<string | null> {
  if (!cookie || !nonce) return null;
  try {
    const { payload } = await jwtVerify(cookie, keyFor('signin-state'), { algorithms: ['HS256'] });
    if (payload['nonce'] !== nonce) return null;
    return safeReturnTo(payload['ret']);
  } catch {
    return null;
  }
}

// ── Authorization codes that carry the person, without a database column ─────

/**
 * A new authorization code that carries the person who approved it, sealed (encrypted) so that
 * the client it is handed to cannot read it. Each code is still stored hashed and single-use by
 * oauthStore; the seal only carries the person from the authorize step to the token step.
 */
export async function sealAuthorizationCode(person: string): Promise<string> {
  return new EncryptJWT({ person: person.toLowerCase(), n: randomBytes(16).toString('base64url') })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .encrypt(keyFor('authorization-code'));
}

/** The person a code was approved by, or null for a code that carries none (or cannot be opened). */
export async function personFromAuthorizationCode(code: string): Promise<string | null> {
  try {
    const { payload } = await jwtDecrypt(code, keyFor('authorization-code'));
    return typeof payload['person'] === 'string' ? payload['person'] : null;
  } catch {
    return null;
  }
}

// ── Cookies ───────────────────────────────────────────────────────────────────

/** Read one cookie from a request's Cookie header. */
export function cookieFrom(header: string | null, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** A Set-Cookie value: HttpOnly, Secure, SameSite=Lax (AuthKit returns by a cross-site navigation), Path=/api/oauth. */
export function setCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/api/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearCookie(name: string): string {
  return `${name}=; Path=/api/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
