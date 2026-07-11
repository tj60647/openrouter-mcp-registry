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
 * then the persistent oauth_clients table.
 */
export async function findClient(clientId: string): Promise<OAuthClient | null> {
  const staticClient = getStaticClient();
  if (staticClient && clientId === staticClient.clientId) return staticClient;

  const result = await sql`
    SELECT client_id, client_secret_hash, client_name, redirect_uris,
           grant_types, token_endpoint_auth_method, scope
    FROM oauth_clients
    WHERE client_id = ${clientId}
    LIMIT 1
  `;
  const row = result.rows[0] as ClientRow | undefined;
  return row ? rowToClient(row) : null;
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
