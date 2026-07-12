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
  hashAuthorizationCode,
  filterScopes,
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
  return {
    clientId: row.client_id,
    clientSecretHash: row.client_secret_hash,
    clientName: row.client_name,
    redirectUris: row.redirect_uris ?? [],
    grantTypes: row.grant_types ?? [],
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
}

/**
 * Register a new dynamic client (RFC 7591). Interactive MCP clients register as
 * public clients (PKCE, no secret); pass isPublic=false to mint a confidential
 * client with a secret. Returns the plaintext secret exactly once (null for
 * public clients).
 */
export async function createDynamicClient(params: {
  clientName: string;
  requestedScope?: string;
  redirectUris: string[];
  isPublic: boolean;
}): Promise<DynamicClientRegistration> {
  const clientId = generateClientId();
  const scope = filterScopes(params.requestedScope);
  const grantTypes = ['authorization_code', 'refresh_token'];

  const clientSecret = params.isPublic ? null : generateClientSecret();
  const clientSecretHash = clientSecret ? hashClientSecret(clientSecret) : null;
  const authMethod = params.isPublic ? 'none' : 'client_secret_post';

  await sql`
    INSERT INTO oauth_clients (
      client_id, client_secret_hash, client_name, redirect_uris,
      grant_types, token_endpoint_auth_method, scope
    ) VALUES (
      ${clientId}, ${clientSecretHash}, ${params.clientName}, ${params.redirectUris as unknown as string},
      ${grantTypes as unknown as string}, ${authMethod}, ${scope}
    )
  `;

  return {
    clientId,
    clientSecret,
    clientName: params.clientName,
    redirectUris: params.redirectUris,
    grantTypes,
    tokenEndpointAuthMethod: authMethod,
    scope,
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
