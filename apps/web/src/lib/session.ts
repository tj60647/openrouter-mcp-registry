/**
 * Signed admin session tokens, using the Web Crypto API so they work in both
 * the Edge (middleware) and Node.js (API route) runtimes.
 *
 * Format: `v2.<base64url(payload)>.<hmac-sha256-hex>`
 *   payload = { u: username, sid: session id, iat: issued-at ms }
 *   HMAC is computed over the base64url payload string with ADMIN_SESSION_SECRET.
 *
 * Carrying the username + a random session id (vs. the old bare timestamp)
 * gives the admin UI an identity to display and a handle for future revocation.
 */

export const SESSION_COOKIE = 'admin_session';
export const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const TOKEN_VERSION = 'v2';

export interface SessionPayload {
  username: string;
  sid: string;
  iat: number;
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function base64urlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(input: string): string {
  const bin = atob(input.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function hmacSign(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return toHex(sig);
}

function randomSid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Creates a signed session token for the given admin username. */
export async function createSessionToken(secret: string, username: string): Promise<string> {
  const payload: SessionPayload = { username, sid: randomSid(), iat: Date.now() };
  const encoded = base64urlEncode(JSON.stringify(payload));
  const hmac = await hmacSign(secret, encoded);
  return `${TOKEN_VERSION}.${encoded}.${hmac}`;
}

function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a.codePointAt(i) ?? 0) ^ (b.codePointAt(i) ?? 0);
  }
  return diff === 0;
}

/**
 * Verifies a session token and returns its payload, or null if the signature is
 * invalid, the token is malformed, or the session has expired.
 */
export async function verifySessionToken(
  token: string,
  secret: string,
): Promise<SessionPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null;
  const [, encoded, provided] = parts;

  const expected = await hmacSign(secret, encoded);
  if (!timingSafeStringEqual(expected, provided)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(base64urlDecode(encoded)) as SessionPayload;
  } catch {
    return null;
  }

  if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) return null;
  if (Date.now() - payload.iat > SESSION_TTL_MS) return null;
  if (typeof payload.username !== 'string' || !payload.username) return null;

  return payload;
}
