/**
 * OAuth 2.0 Authorization Server helpers for the MCP endpoint.
 *
 * Implements the Client Credentials grant (RFC 6749 §4.4) with HS256 JWTs.
 * Static clients are configured via MCP_CLIENT_ID / MCP_CLIENT_SECRET env vars.
 * Dynamic clients registered via /api/oauth/register are stored in-process
 * (suitable for single-instance deployments; swap the Map for a DB-backed store
 * in multi-instance / persistent scenarios).
 */

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';

export const OAUTH_AUDIENCE = 'openrouter-mcp-registry';
export const TOKEN_TTL_SECONDS = 3600; // 1 hour

/** Scopes that may be granted to any client (registered or static). */
export const ALLOWED_SCOPES = new Set(['mcp:read']);

// ── JWT helpers ────────────────────────────────────────────────────────────────

function getJwtSecretBytes(): Uint8Array {
  const secret = process.env['OAUTH_JWT_SECRET'];
  if (!secret) throw new Error('OAUTH_JWT_SECRET is not configured');
  return new TextEncoder().encode(secret);
}

/** Returns the issuer URL derived from environment variables. */
export function getIssuerUrl(): string {
  const configured = process.env['NEXT_PUBLIC_MCP_URL'];
  if (configured) return configured.replace(/\/$/, '');
  const vercelUrl = process.env['VERCEL_URL'];
  if (vercelUrl) return `https://${vercelUrl}`;
  return 'http://localhost:3001';
}

/** Sign a short-lived access token for the given client ID and scope. */
export async function signAccessToken(clientId: string, scope: string): Promise<string> {
  return new SignJWT({ scope })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(clientId)
    .setIssuer(getIssuerUrl())
    .setAudience(OAUTH_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
    .sign(getJwtSecretBytes());
}

export interface AccessTokenClaims extends JWTPayload {
  scope?: string;
}

/**
 * Verify a JWT access token and return its claims.
 * Throws on invalid/expired tokens or issuer mismatch.
 */
export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  const { payload } = await jwtVerify<AccessTokenClaims>(token, getJwtSecretBytes(), {
    audience: OAUTH_AUDIENCE,
    issuer: getIssuerUrl(),
  });
  return payload;
}

// ── Client credential hashing ─────────────────────────────────────────────────

// Per-process nonce ensures timing-safe comparisons regardless of secret length.
const _CLIENT_SECRET_NONCE = randomBytes(32);

export function hashClientSecret(secret: string): string {
  return createHmac('sha256', _CLIENT_SECRET_NONCE).update(secret).digest('hex');
}

export function verifyClientSecret(provided: string, storedHash: string): boolean {
  const providedHash = hashClientSecret(provided);
  const a = Buffer.from(providedHash, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Client store ───────────────────────────────────────────────────────────────

export interface OAuthClient {
  clientId: string;
  /** HMAC-SHA256 hash of the plain-text secret (hashed with the per-process nonce). */
  clientSecretHash: string;
  clientName: string;
  /** Space-separated list of granted scopes. */
  scope: string;
}

/** In-memory dynamic client registry (per-process). */
const _dynamicClients = new Map<string, OAuthClient>();

/**
 * Look up a client by ID.
 * Checks the static env-configured client first, then any dynamically registered clients.
 */
export function getClient(clientId: string): OAuthClient | null {
  const staticId = process.env['MCP_CLIENT_ID'];
  const staticSecret = process.env['MCP_CLIENT_SECRET'];
  if (staticId && staticSecret && clientId === staticId) {
    return {
      clientId: staticId,
      clientSecretHash: hashClientSecret(staticSecret),
      clientName: 'Built-in service client',
      scope: 'mcp:read admin:write',
    };
  }
  return _dynamicClients.get(clientId) ?? null;
}

/**
 * Register a new dynamic client.
 * Only scopes listed in ALLOWED_SCOPES are granted; unknown scopes are silently
 * dropped. Defaults to 'mcp:read' if no valid scope remains after filtering.
 *
 * Returns the plain-text client secret (shown once; not stored in plain text).
 */
export function registerDynamicClient(
  clientName: string,
  requestedScope = 'mcp:read'
): { clientId: string; clientSecret: string; scope: string } {
  const scope =
    requestedScope
      .split(' ')
      .filter((s) => ALLOWED_SCOPES.has(s))
      .join(' ') || 'mcp:read';

  const clientId = randomBytes(16).toString('hex');
  const clientSecret = randomBytes(32).toString('base64url');
  _dynamicClients.set(clientId, {
    clientId,
    clientSecretHash: hashClientSecret(clientSecret),
    clientName,
    scope,
  });
  return { clientId, clientSecret, scope };
}
