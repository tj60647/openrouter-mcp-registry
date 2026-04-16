/**
 * Session cookie helpers using the Web Crypto API.
 * Works in both Edge (middleware) and Node.js (API routes) runtimes.
 *
 * Cookie format: `<unix-ms>.<hmac-sha256-hex>`
 * The HMAC is computed over the timestamp string using ADMIN_SESSION_SECRET.
 */

export const SESSION_COOKIE = 'admin_session';
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
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

/** Creates a signed session token string to store in the cookie. */
export async function createSessionToken(secret: string): Promise<string> {
  const ts = Date.now().toString();
  const hmac = await hmacSign(secret, ts);
  return `${ts}.${hmac}`;
}

/**
 * Verifies a session token string.
 * Returns false if the HMAC is invalid or the session has expired.
 */
export async function verifySessionToken(token: string, secret: string): Promise<boolean> {
  const dot = token.indexOf('.');
  if (dot === -1) return false;

  const ts = token.slice(0, dot);
  const provided = token.slice(dot + 1);

  const timestamp = Number(ts);
  if (!Number.isFinite(timestamp)) return false;
  if (Date.now() - timestamp > SESSION_TTL_MS) return false;

  const expected = await hmacSign(secret, ts);

  // Constant-time comparison over fixed-length hex strings
  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= (expected.codePointAt(i) ?? 0) ^ (provided.codePointAt(i) ?? 0);
  }
  return diff === 0;
}
