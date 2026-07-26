/**
 * OAuth 2.1 Authorization Server helpers for the MCP endpoint.
 *
 * Pure crypto / JWT layer — no database access, so it stays unit-testable and
 * free of runtime coupling. Persistence (dynamic clients, authorization codes)
 * lives in ./oauthStore.
 *
 * Supported grants: authorization_code (+ PKCE) and refresh_token for
 * interactive MCP clients, plus client_credentials for trusted service clients.
 */

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export const OAUTH_AUDIENCE = 'openrouter-registry-mcp';
export const TOKEN_TTL_SECONDS = 3600; // 1 hour access token
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

/** Scopes that may be granted to any client (registered or static). */
export const ALLOWED_SCOPES = new Set(['mcp:read']);

/**
 * Grants this authorization server implements. Advertised as
 * `grant_types_supported` and used to validate RFC 7591 registrations, so the
 * metadata document and the enforcement path can never drift apart.
 */
export const SUPPORTED_GRANT_TYPES: readonly string[] = [
  'authorization_code',
  'refresh_token',
  'client_credentials',
];

/** Filter a requested scope string down to allowed scopes; default to mcp:read. */
export function filterScopes(requestedScope: string | undefined): string {
  const filtered = (requestedScope ?? '')
    .split(' ')
    .filter((s) => ALLOWED_SCOPES.has(s));
  return filtered.length > 0 ? filtered.join(' ') : 'mcp:read';
}

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
  return new SignJWT({ scope, token_use: 'access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(clientId)
    .setIssuer(getIssuerUrl())
    .setAudience(OAUTH_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
    .sign(getJwtSecretBytes());
}

/** Sign a long-lived refresh token. Distinguished from access tokens by token_use. */
export async function signRefreshToken(clientId: string, scope: string): Promise<string> {
  return new SignJWT({ scope, token_use: 'refresh' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(clientId)
    .setIssuer(getIssuerUrl())
    .setAudience(OAUTH_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${REFRESH_TOKEN_TTL_SECONDS}s`)
    .sign(getJwtSecretBytes());
}

export interface AccessTokenClaims extends JWTPayload {
  scope?: string;
  token_use?: string;
}

/**
 * Verify a JWT access token and return its claims.
 * Throws on invalid/expired tokens, issuer/audience mismatch, or if the token
 * is a refresh token being presented as an access token.
 */
export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  const { payload } = await jwtVerify<AccessTokenClaims>(token, getJwtSecretBytes(), {
    audience: OAUTH_AUDIENCE,
    issuer: getIssuerUrl(),
  });
  if (payload.token_use === 'refresh') {
    throw new Error('refresh token cannot be used as an access token');
  }
  return payload;
}

/** Verify a refresh token and return its claims. Throws unless token_use is 'refresh'. */
export async function verifyRefreshToken(token: string): Promise<AccessTokenClaims> {
  const { payload } = await jwtVerify<AccessTokenClaims>(token, getJwtSecretBytes(), {
    audience: OAUTH_AUDIENCE,
    issuer: getIssuerUrl(),
  });
  if (payload.token_use !== 'refresh') {
    throw new Error('not a refresh token');
  }
  return payload;
}

// ── PKCE (RFC 7636) ─────────────────────────────────────────────────────────────

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/** Compute the S256 code challenge for a verifier: BASE64URL(SHA256(verifier)). */
export function computePkceChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

/** Constant-time check that a PKCE verifier matches a stored S256 challenge. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  const computed = computePkceChallenge(verifier);
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Client credential hashing ─────────────────────────────────────────────────

/**
 * Stable hash for client secrets. Client secrets are high-entropy random tokens
 * (not user passwords), so a fast SHA-256 is appropriate and — unlike a
 * per-process salt — verifies identically across serverless instances.
 */
export function hashClientSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function verifyClientSecret(provided: string, storedHash: string): boolean {
  const providedHash = hashClientSecret(provided);
  const a = Buffer.from(providedHash, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Constant-time comparison of two opaque bearer tokens. Both sides are hashed
 * to a fixed-length digest first, so the comparison cannot leak the expected
 * token's length through an early-exit or a thrown length mismatch.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const ah = createHash('sha256').update(a).digest();
  const bh = createHash('sha256').update(b).digest();
  return timingSafeEqual(ah, bh);
}

// ── Credential generation ───────────────────────────────────────────────────────

export function generateClientId(): string {
  return randomBytes(16).toString('hex');
}

export function generateClientSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** Generate an opaque authorization code (returned to the client, stored hashed). */
export function generateAuthorizationCode(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Generate the RFC 7592 registration access token handed to a client exactly
 * once at registration time. Stored hashed; used to read or delete its own
 * registration.
 */
export function generateRegistrationAccessToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 hash used to store authorization codes at rest. */
export function hashAuthorizationCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

// ── Client model ────────────────────────────────────────────────────────────────

export interface OAuthClient {
  clientId: string;
  /** SHA-256 hash of the secret, or null for public (PKCE-only) clients. */
  clientSecretHash: string | null;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  tokenEndpointAuthMethod: string;
  /** Space-separated list of granted scopes. */
  scope: string;
}

// ── Registration metadata validation (RFC 7591 §2, §3.2.1) ─────────────────────

/**
 * Raised when a registration request carries metadata this server refuses.
 * The registration endpoint maps it to `400 invalid_client_metadata`.
 */
export class InvalidClientMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidClientMetadataError';
  }
}

export interface ResolvedGrantTypes {
  /** The exact list to persist and echo back in the registration response. */
  grantTypes: string[];
  /** Public clients get no secret and token_endpoint_auth_method 'none'. */
  isPublic: boolean;
}

/**
 * Resolve the grant types a registration request should end up with (RFC 7591
 * §3.2.1) and decide whether the client is public or confidential.
 *
 * When `requested` is undefined the defaults preserve the historical behaviour:
 * redirect_uris ⇒ interactive authorization-code client, no redirect_uris ⇒
 * confidential client_credentials service client.
 *
 * `client_credentials` is deliberately incompatible with `redirect_uris`: a
 * client registered with redirect_uris is public and holds no secret, so
 * honouring client_credentials for it would let anyone who learns the
 * client_id mint access tokens.
 *
 * Throws InvalidClientMetadataError for any combination this server refuses.
 */
export function resolveGrantTypes(
  requested: string[] | undefined,
  redirectUris: string[],
): ResolvedGrantTypes {
  const hasRedirectUris = redirectUris.length > 0;

  if (requested === undefined) {
    return hasRedirectUris
      ? { grantTypes: ['authorization_code', 'refresh_token'], isPublic: true }
      : { grantTypes: ['client_credentials'], isPublic: false };
  }

  if (requested.length === 0) {
    throw new InvalidClientMetadataError('grant_types must not be empty');
  }

  const grantTypes = [...new Set(requested)];

  const unsupported = grantTypes.find((g) => !SUPPORTED_GRANT_TYPES.includes(g));
  if (unsupported) {
    throw new InvalidClientMetadataError(
      `unsupported grant_type: ${unsupported}. Supported: ${SUPPORTED_GRANT_TYPES.join(', ')}`,
    );
  }

  const wantsAuthCode = grantTypes.includes('authorization_code');
  const wantsRefresh = grantTypes.includes('refresh_token');
  const wantsClientCredentials = grantTypes.includes('client_credentials');

  if (wantsRefresh && !wantsAuthCode) {
    throw new InvalidClientMetadataError(
      'refresh_token requires authorization_code to also be requested',
    );
  }
  if ((wantsAuthCode || wantsRefresh) && !hasRedirectUris) {
    throw new InvalidClientMetadataError('authorization_code requires at least one redirect_uri');
  }
  if (wantsClientCredentials && hasRedirectUris) {
    throw new InvalidClientMetadataError(
      'client_credentials is not available to public clients registered with redirect_uris',
    );
  }

  // Public vs confidential follows the resolved grants, not redirect_uris alone.
  return { grantTypes, isPublic: !wantsClientCredentials };
}

/**
 * The static service client configured via MCP_CLIENT_ID / MCP_CLIENT_SECRET.
 * Used for the client_credentials grant (e.g. apps/web server routes).
 * Returns null when the env vars are not both set.
 */
export function getStaticClient(): OAuthClient | null {
  const staticId = process.env['MCP_CLIENT_ID'];
  const staticSecret = process.env['MCP_CLIENT_SECRET'];
  if (!staticId || !staticSecret) return null;
  return {
    clientId: staticId,
    clientSecretHash: hashClientSecret(staticSecret),
    clientName: 'Built-in service client',
    redirectUris: [],
    grantTypes: ['client_credentials'],
    tokenEndpointAuthMethod: 'client_secret_post',
    scope: 'mcp:read',
  };
}
