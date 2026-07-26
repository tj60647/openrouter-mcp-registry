/**
 * Postgres-backed persistence for OAuth 2.1 dynamic clients and authorization
 * codes. Kept separate from ./oauth (the pure crypto/JWT layer) so that module
 * stays unit-testable and DB-free.
 *
 * All functions are safe to call on Vercel's multi-instance serverless runtime:
 * state lives in Neon/Postgres, not in per-process memory.
 */

import { sql } from '@vercel/postgres';
import {
  type OAuthClient,
  getStaticClient,
  hashClientSecret,
  generateClientId,
  generateClientSecret,
  generateAuthorizationCode,
  generateRegistrationAccessToken,
  hashAuthorizationCode,
  filterScopes,
  resolveGrantTypes,
} from './oauth';

const AUTH_CODE_TTL_MS = 60_000; // authorization codes are valid for 60 seconds

interface ClientRow {
  client_id: string;
  client_secret_hash: string | null;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  token_endpoint_auth_method: string;
  scope: string;
}

function rowToClient(row: ClientRow): OAuthClient {
  const redirectUris = row.redirect_uris ?? [];
  const grantTypes = [...(row.grant_types ?? [])];

  // Legacy-compat shim: before grant_types were honoured, every dynamic
  // registration was stored as ['authorization_code','refresh_token'] no matter
  // how the client actually authenticated. A stored secret with no redirect_uris
  // is a confidential service client that has been using client_credentials
  // since the day it registered, so keep that grant working for it.
  // Public (secret-less) clients are deliberately NOT grandfathered — handing
  // them client_credentials is exactly the auth bypass this check closes.
  if (
    row.client_secret_hash &&
    redirectUris.length === 0 &&
    !grantTypes.includes('client_credentials')
  ) {
    grantTypes.push('client_credentials');
  }

  return {
    clientId: row.client_id,
    clientSecretHash: row.client_secret_hash,
    clientName: row.client_name,
    redirectUris,
    grantTypes,
    tokenEndpointAuthMethod: row.token_endpoint_auth_method,
    scope: row.scope,
  };
}

/**
 * Look up a client by ID. Checks the static env-configured service client first,
 * then the persistent oauth_clients table. Revoked clients are treated as
 * non-existent so they can no longer obtain tokens.
 */
export async function findClient(clientId: string): Promise<OAuthClient | null> {
  const staticClient = getStaticClient();
  if (staticClient && clientId === staticClient.clientId) return staticClient;

  const result = await sql`
    SELECT client_id, client_secret_hash, client_name, redirect_uris,
           grant_types, token_endpoint_auth_method, scope
    FROM oauth_clients
    WHERE client_id = ${clientId} AND revoked_at IS NULL
    LIMIT 1
  `;
  const row = result.rows[0] as ClientRow | undefined;
  return row ? rowToClient(row) : null;
}

export interface AdminClientView {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  scope: string;
  tokenEndpointAuthMethod: string;
  createdAt: string;
  revokedAt: string | null;
}

/** List all dynamically-registered clients for the admin panel (newest first). */
export async function listClients(): Promise<AdminClientView[]> {
  const result = await sql`
    SELECT client_id, client_name, redirect_uris, scope,
           token_endpoint_auth_method, created_at, revoked_at
    FROM oauth_clients
    ORDER BY created_at DESC
  `;
  return result.rows.map((r) => ({
    clientId: r.client_id as string,
    clientName: r.client_name as string,
    redirectUris: (r.redirect_uris as string[]) ?? [],
    scope: r.scope as string,
    tokenEndpointAuthMethod: r.token_endpoint_auth_method as string,
    createdAt: new Date(r.created_at as string).toISOString(),
    revokedAt: r.revoked_at ? new Date(r.revoked_at as string).toISOString() : null,
  }));
}

/** Revoke a client. Returns true if a non-revoked client was revoked. */
export async function revokeClient(clientId: string): Promise<boolean> {
  const result = await sql`
    UPDATE oauth_clients
    SET revoked_at = NOW()
    WHERE client_id = ${clientId} AND revoked_at IS NULL
  `;
  return (result.rowCount ?? 0) > 0;
}

/** Restore a previously-revoked client. Returns true if one was restored. */
export async function unrevokeClient(clientId: string): Promise<boolean> {
  const result = await sql`
    UPDATE oauth_clients
    SET revoked_at = NULL
    WHERE client_id = ${clientId} AND revoked_at IS NOT NULL
  `;
  return (result.rowCount ?? 0) > 0;
}

export interface DynamicClientRegistration {
  clientId: string;
  clientSecret: string | null;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  tokenEndpointAuthMethod: string;
  scope: string;
  /** RFC 7592 management token — plaintext, returned to the caller exactly once. */
  registrationAccessToken: string;
  /** Unix seconds, echoed as `client_id_issued_at` (RFC 7591 §3.2.1). */
  clientIdIssuedAt: number;
}

/**
 * Register a new dynamic client (RFC 7591).
 *
 * The requested `grant_types` are resolved and validated by resolveGrantTypes,
 * which also decides public vs confidential: `client_credentials` mints a
 * confidential client with a secret, anything else is public (PKCE, no secret).
 * Validation lives behind this function so no caller can persist a client whose
 * grants contradict its credentials. Throws InvalidClientMetadataError — before
 * anything is written — when the requested metadata is refused.
 *
 * Returns the plaintext client secret (null for public clients) and the
 * plaintext registration access token exactly once; only hashes are stored.
 */
export async function createDynamicClient(params: {
  clientName: string;
  requestedScope?: string;
  redirectUris: string[];
  requestedGrantTypes?: string[];
}): Promise<DynamicClientRegistration> {
  const { grantTypes, isPublic } = resolveGrantTypes(
    params.requestedGrantTypes,
    params.redirectUris,
  );

  const clientId = generateClientId();
  const scope = filterScopes(params.requestedScope);

  const clientSecret = isPublic ? null : generateClientSecret();
  const clientSecretHash = clientSecret ? hashClientSecret(clientSecret) : null;
  const authMethod = isPublic ? 'none' : 'client_secret_post';

  const registrationAccessToken = generateRegistrationAccessToken();
  const registrationTokenHash = hashClientSecret(registrationAccessToken);

  const result = await sql`
    INSERT INTO oauth_clients (
      client_id, client_secret_hash, client_name, redirect_uris,
      grant_types, token_endpoint_auth_method, scope, registration_access_token_hash
    ) VALUES (
      ${clientId}, ${clientSecretHash}, ${params.clientName}, ${params.redirectUris as unknown as string},
      ${grantTypes as unknown as string}, ${authMethod}, ${scope}, ${registrationTokenHash}
    )
    RETURNING created_at
  `;
  const createdAt = result.rows[0]?.['created_at'] as string | Date | undefined;

  return {
    clientId,
    clientSecret,
    clientName: params.clientName,
    redirectUris: params.redirectUris,
    grantTypes,
    tokenEndpointAuthMethod: authMethod,
    scope,
    registrationAccessToken,
    clientIdIssuedAt: toUnixSeconds(createdAt),
  };
}

/** Unix seconds for a timestamp column, falling back to now when absent. */
function toUnixSeconds(value: string | Date | undefined | null): number {
  const ms = value ? new Date(value).getTime() : Date.now();
  return Math.floor((Number.isNaN(ms) ? Date.now() : ms) / 1000);
}

export interface ClientRegistration {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  tokenEndpointAuthMethod: string;
  scope: string;
  clientIdIssuedAt: number;
  /** SHA-256 hash of the RFC 7592 management token; null for pre-7592 clients. */
  registrationAccessTokenHash: string | null;
}

/**
 * Read a dynamic client's registration record for the RFC 7592 management
 * endpoint. Revoked clients are treated as non-existent. The returned
 * grant_types pass through rowToClient so they match what the token endpoint
 * will actually accept (including the legacy grandfather rule).
 */
export async function findClientRegistration(clientId: string): Promise<ClientRegistration | null> {
  const result = await sql`
    SELECT client_id, client_secret_hash, client_name, redirect_uris,
           grant_types, token_endpoint_auth_method, scope,
           created_at, registration_access_token_hash
    FROM oauth_clients
    WHERE client_id = ${clientId} AND revoked_at IS NULL
    LIMIT 1
  `;
  const row = result.rows[0] as
    | (ClientRow & { created_at: string; registration_access_token_hash: string | null })
    | undefined;
  if (!row) return null;

  const client = rowToClient(row);
  return {
    clientId: client.clientId,
    clientName: client.clientName,
    redirectUris: client.redirectUris,
    grantTypes: client.grantTypes,
    tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
    scope: client.scope,
    clientIdIssuedAt: toUnixSeconds(row.created_at),
    registrationAccessTokenHash: row.registration_access_token_hash ?? null,
  };
}

/**
 * Create a single-use, PKCE-bound authorization code. Stores only the code's
 * SHA-256 hash and returns the plaintext code to redirect back to the client.
 */
export async function createAuthorizationCode(params: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
}): Promise<string> {
  const code = generateAuthorizationCode();
  const codeHash = hashAuthorizationCode(code);
  const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_MS).toISOString();

  await sql`
    INSERT INTO oauth_authorization_codes (
      code_hash, client_id, redirect_uri, code_challenge, code_challenge_method, scope, expires_at
    ) VALUES (
      ${codeHash}, ${params.clientId}, ${params.redirectUri},
      ${params.codeChallenge}, ${params.codeChallengeMethod}, ${params.scope}, ${expiresAt}
    )
  `;
  return code;
}

export interface ConsumedAuthorizationCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  expired: boolean;
}

/**
 * Atomically redeem an authorization code: the row is deleted (single-use) and
 * its data returned. Returns null if the code does not exist. The `expired`
 * flag lets the caller reject stale codes while still consuming them.
 */
export async function consumeAuthorizationCode(
  code: string,
): Promise<ConsumedAuthorizationCode | null> {
  const codeHash = hashAuthorizationCode(code);
  const result = await sql`
    DELETE FROM oauth_authorization_codes
    WHERE code_hash = ${codeHash}
    RETURNING client_id, redirect_uri, code_challenge, code_challenge_method, scope, expires_at
  `;
  const row = result.rows[0] as
    | {
        client_id: string;
        redirect_uri: string;
        code_challenge: string;
        code_challenge_method: string;
        scope: string;
        expires_at: string;
      }
    | undefined;
  if (!row) return null;

  return {
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    codeChallengeMethod: row.code_challenge_method,
    scope: row.scope,
    expired: new Date(row.expires_at).getTime() < Date.now(),
  };
}

// ── Usage tracking ──────────────────────────────────────────────────────────────

/** Record a single MCP tool call for usage-by-agent reporting. Best-effort. */
export async function recordUsage(clientId: string, tool: string, ok: boolean): Promise<void> {
  await sql`
    INSERT INTO mcp_usage (client_id, tool, ok)
    VALUES (${clientId}, ${tool}, ${ok})
  `;
}

export interface UsageByClient {
  clientId: string;
  clientName: string | null;
  totalCalls: number;
  errorCalls: number;
  lastCalledAt: string | null;
}

export interface UsageByTool {
  tool: string;
  totalCalls: number;
}

export interface UsageReport {
  totalCalls: number;
  windowDays: number;
  byClient: UsageByClient[];
  byTool: UsageByTool[];
}

/**
 * Aggregate usage over the last `windowDays` days. Client names are resolved
 * from oauth_clients; the built-in service client and unknown ids show a label.
 */
export async function getUsageReport(windowDays = 30): Promise<UsageReport> {
  const staticClient = getStaticClient();

  const byClientRes = await sql`
    SELECT u.client_id,
           c.client_name,
           count(*)::int AS total_calls,
           count(*) FILTER (WHERE NOT u.ok)::int AS error_calls,
           max(u.called_at) AS last_called_at
    FROM mcp_usage u
    LEFT JOIN oauth_clients c ON c.client_id = u.client_id
    WHERE u.called_at > NOW() - (${windowDays} || ' days')::interval
    GROUP BY u.client_id, c.client_name
    ORDER BY total_calls DESC
  `;

  const byToolRes = await sql`
    SELECT tool, count(*)::int AS total_calls
    FROM mcp_usage
    WHERE called_at > NOW() - (${windowDays} || ' days')::interval
    GROUP BY tool
    ORDER BY total_calls DESC
  `;

  const totalRes = await sql`
    SELECT count(*)::int AS n
    FROM mcp_usage
    WHERE called_at > NOW() - (${windowDays} || ' days')::interval
  `;

  const byClient: UsageByClient[] = byClientRes.rows.map((r) => {
    const clientId = r.client_id as string;
    let clientName = (r.client_name as string | null) ?? null;
    if (!clientName) {
      if (staticClient && clientId === staticClient.clientId) clientName = 'Built-in service client';
      else if (clientId === 'anonymous') clientName = 'Anonymous (dev)';
    }
    return {
      clientId,
      clientName,
      totalCalls: r.total_calls as number,
      errorCalls: r.error_calls as number,
      lastCalledAt: r.last_called_at ? new Date(r.last_called_at as string).toISOString() : null,
    };
  });

  return {
    totalCalls: (totalRes.rows[0]?.n as number) ?? 0,
    windowDays,
    byClient,
    byTool: byToolRes.rows.map((r) => ({
      tool: r.tool as string,
      totalCalls: r.total_calls as number,
    })),
  };
}
