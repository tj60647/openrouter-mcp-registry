/**
 * @file oauth-register.test.ts
 * Tests for RFC 7591 dynamic client registration, the RFC 7592 management
 * endpoint, and grant-type enforcement at the token endpoint.
 * The @vercel/postgres module is mocked so no real DB connection is needed.
 *
 * Author: Thomas J McLeish
 * License: MIT
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mock @vercel/postgres ─────────────────────────────────────────────────────
// vi.hoisted is required because vi.mock factories are hoisted before const
// declarations, so mockSql would be uninitialized at execution time without it.

const { mockQuery, mockSql } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockSql: vi.fn(),
}));

vi.mock('@vercel/postgres', () => ({
  sql: mockSql,
  db: { query: mockQuery },
}));

// ── Imports under test (after mock registration) ─────────────────────────────

import { hashClientSecret } from '../lib/oauth';
import { createDynamicClient, findClient, findClientRegistration } from '../lib/oauthStore';
import { POST as registerPost } from '../app/api/oauth/register/route';
import { POST as tokenPost } from '../app/api/oauth/token/route';
import {
  GET as manageGet,
  DELETE as manageDelete,
} from '../app/api/oauth/register/[client_id]/route';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Every rate limiter is keyed by IP, so each test uses its own. */
let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `10.0.0.${ipCounter % 250}`;
}

interface ClientRowFixture {
  client_id: string;
  client_secret_hash: string | null;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  token_endpoint_auth_method: string;
  scope: string;
  created_at?: string;
  registration_access_token_hash?: string | null;
}

function makeClientRow(overrides: Partial<ClientRowFixture> = {}): ClientRowFixture {
  return {
    client_id: 'client-123',
    client_secret_hash: null,
    client_name: 'Test client',
    redirect_uris: [],
    grant_types: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_method: 'none',
    scope: 'mcp:read',
    created_at: '2026-01-01T00:00:00.000Z',
    registration_access_token_hash: null,
    ...overrides,
  };
}

function registerRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:3001/api/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
    body: JSON.stringify(body),
  });
}

function tokenRequest(form: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost:3001/api/oauth/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-for': nextIp(),
    },
    body: new URLSearchParams(form).toString(),
  });
}

function manageRequest(method: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:3001/api/oauth/register/client-123', {
    method,
    headers: { 'x-forwarded-for': nextIp(), ...headers },
  });
}

beforeEach(() => {
  mockSql.mockReset();
  mockSql.mockResolvedValue({ rows: [], rowCount: 0 });
  vi.stubEnv('NEXT_PUBLIC_MCP_URL', 'http://localhost:3001');
  vi.stubEnv('OAUTH_JWT_SECRET', 'test-jwt-secret-at-least-32-bytes-long!!');
  vi.stubEnv('OAUTH_DISABLE_REGISTRATION', '');
  vi.stubEnv('OAUTH_REGISTRATION_ACCESS_TOKEN', '');
  vi.stubEnv('MCP_CLIENT_ID', '');
  vi.stubEnv('MCP_CLIENT_SECRET', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── createDynamicClient ───────────────────────────────────────────────────────

describe('createDynamicClient', () => {
  it('persists and returns the resolved grant types for a public client', async () => {
    mockSql.mockResolvedValue({ rows: [{ created_at: '2026-01-01T00:00:00.000Z' }] });

    const reg = await createDynamicClient({
      clientName: 'Interactive client',
      redirectUris: ['https://app.example.com/cb'],
    });

    expect(reg.grantTypes).toEqual(['authorization_code', 'refresh_token']);
    expect(reg.clientSecret).toBeNull();
    expect(reg.tokenEndpointAuthMethod).toBe('none');
    expect(reg.clientIdIssuedAt).toBe(Math.floor(Date.parse('2026-01-01T00:00:00.000Z') / 1000));

    // The resolved list is what gets written to oauth_clients.
    const values = mockSql.mock.calls[0]!.slice(1);
    expect(values).toContainEqual(['authorization_code', 'refresh_token']);
  });

  it('issues a secret and client_credentials when no redirect_uris are given', async () => {
    mockSql.mockResolvedValue({ rows: [{ created_at: '2026-01-01T00:00:00.000Z' }] });

    const reg = await createDynamicClient({ clientName: 'Service client', redirectUris: [] });

    expect(reg.grantTypes).toEqual(['client_credentials']);
    expect(reg.clientSecret).toBeTruthy();
    expect(reg.tokenEndpointAuthMethod).toBe('client_secret_post');
  });

  it('returns a registration access token and stores only its hash', async () => {
    mockSql.mockResolvedValue({ rows: [{ created_at: '2026-01-01T00:00:00.000Z' }] });

    const reg = await createDynamicClient({ clientName: 'Service client', redirectUris: [] });

    expect(reg.registrationAccessToken).toBeTruthy();
    const values = mockSql.mock.calls[0]!.slice(1);
    expect(values).toContain(hashClientSecret(reg.registrationAccessToken));
    expect(values).not.toContain(reg.registrationAccessToken);
  });

  it('rejects invalid grant_types before writing anything to the database', async () => {
    await expect(
      createDynamicClient({
        clientName: 'Sneaky client',
        redirectUris: ['https://app.example.com/cb'],
        requestedGrantTypes: ['client_credentials'],
      }),
    ).rejects.toThrow(/client_credentials is not available to public clients/);
    expect(mockSql).not.toHaveBeenCalled();
  });
});

// ── rowToClient legacy grandfather rule ───────────────────────────────────────

describe('findClient legacy grant_types compatibility', () => {
  it('grandfathers client_credentials for confidential clients with no redirect_uris', async () => {
    mockSql.mockResolvedValue({
      rows: [
        makeClientRow({
          client_secret_hash: hashClientSecret('legacy-secret'),
          token_endpoint_auth_method: 'client_secret_post',
          grant_types: ['authorization_code', 'refresh_token'],
        }),
      ],
    });

    const client = await findClient('client-123');

    expect(client?.grantTypes).toContain('client_credentials');
  });

  it('does NOT grandfather public clients (the bypass being closed)', async () => {
    mockSql.mockResolvedValue({
      rows: [
        makeClientRow({
          client_secret_hash: null,
          redirect_uris: ['https://app.example.com/cb'],
          grant_types: ['authorization_code', 'refresh_token'],
        }),
      ],
    });

    const client = await findClient('client-123');

    expect(client?.grantTypes).not.toContain('client_credentials');
  });

  it('does NOT grandfather a confidential client that registered redirect_uris', async () => {
    mockSql.mockResolvedValue({
      rows: [
        makeClientRow({
          client_secret_hash: hashClientSecret('legacy-secret'),
          redirect_uris: ['https://app.example.com/cb'],
          grant_types: ['authorization_code', 'refresh_token'],
        }),
      ],
    });

    const client = await findClient('client-123');

    expect(client?.grantTypes).not.toContain('client_credentials');
  });

  it('does not duplicate client_credentials when it is already stored', async () => {
    mockSql.mockResolvedValue({
      rows: [
        makeClientRow({
          client_secret_hash: hashClientSecret('secret'),
          grant_types: ['client_credentials'],
          token_endpoint_auth_method: 'client_secret_post',
        }),
      ],
    });

    const client = await findClient('client-123');

    expect(client?.grantTypes).toEqual(['client_credentials']);
  });
});

// ── POST /api/oauth/register ──────────────────────────────────────────────────

describe('POST /api/oauth/register', () => {
  beforeEach(() => {
    mockSql.mockResolvedValue({ rows: [{ created_at: '2026-01-01T00:00:00.000Z' }] });
  });

  it('echoes the requested grant_types and adds RFC 7591 response members', async () => {
    const res = await registerPost(
      registerRequest({
        client_name: 'Interactive client',
        redirect_uris: ['https://app.example.com/cb'],
        grant_types: ['authorization_code', 'refresh_token'],
      }),
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(201);
    expect(body['grant_types']).toEqual(['authorization_code', 'refresh_token']);
    expect(body['token_endpoint_auth_method']).toBe('none');
    expect(typeof body['client_id_issued_at']).toBe('number');
    expect(body['client_secret']).toBeUndefined();
    expect(body['client_secret_expires_at']).toBeUndefined();
    expect(body['registration_access_token']).toBeTruthy();
    expect(body['registration_client_uri']).toBe(
      `http://localhost:3001/api/oauth/register/${body['client_id'] as string}`,
    );
  });

  it('issues a secret with client_secret_expires_at: 0 for a client_credentials client', async () => {
    const res = await registerPost(
      registerRequest({ client_name: 'Service client', grant_types: ['client_credentials'] }),
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(201);
    expect(body['grant_types']).toEqual(['client_credentials']);
    expect(body['client_secret']).toBeTruthy();
    expect(body['client_secret_expires_at']).toBe(0);
    expect(body['token_endpoint_auth_method']).toBe('client_secret_post');
  });

  it('rejects an unsupported grant type with invalid_client_metadata', async () => {
    const res = await registerPost(
      registerRequest({ client_name: 'Bad client', grant_types: ['password'] }),
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(body['error']).toBe('invalid_client_metadata');
    expect(body['error_description']).toMatch(/unsupported grant_type: password/);
  });

  it('rejects client_credentials combined with redirect_uris', async () => {
    const res = await registerPost(
      registerRequest({
        client_name: 'Sneaky client',
        redirect_uris: ['https://app.example.com/cb'],
        grant_types: ['client_credentials'],
      }),
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(body['error']).toBe('invalid_client_metadata');
    expect(body['error_description']).toMatch(/not available to public clients/);
  });

  it('rejects grant_types that is not an array of strings', async () => {
    const res = await registerPost(
      registerRequest({ client_name: 'Bad client', grant_types: 'client_credentials' }),
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(body['error']).toBe('invalid_client_metadata');
  });
});

// ── OAUTH_REGISTRATION_ACCESS_TOKEN guard ─────────────────────────────────────

describe('POST /api/oauth/register initial access token', () => {
  beforeEach(() => {
    mockSql.mockResolvedValue({ rows: [{ created_at: '2026-01-01T00:00:00.000Z' }] });
  });

  it('allows registration when OAUTH_REGISTRATION_ACCESS_TOKEN is unset', async () => {
    const res = await registerPost(registerRequest({ client_name: 'Open client' }));
    expect(res.status).toBe(201);
  });

  it('rejects registration without the token when it is configured', async () => {
    vi.stubEnv('OAUTH_REGISTRATION_ACCESS_TOKEN', 'super-secret-initial-token');

    const res = await registerPost(registerRequest({ client_name: 'Anon client' }));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(401);
    expect(body['error']).toBe('invalid_token');
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('rejects a wrong initial access token', async () => {
    vi.stubEnv('OAUTH_REGISTRATION_ACCESS_TOKEN', 'super-secret-initial-token');

    const res = await registerPost(
      registerRequest({ client_name: 'Anon client' }, { authorization: 'Bearer wrong-token' }),
    );

    expect(res.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('accepts the correct initial access token', async () => {
    vi.stubEnv('OAUTH_REGISTRATION_ACCESS_TOKEN', 'super-secret-initial-token');

    const res = await registerPost(
      registerRequest(
        { client_name: 'Trusted client' },
        { authorization: 'Bearer super-secret-initial-token' },
      ),
    );

    expect(res.status).toBe(201);
  });
});

// ── Token endpoint grant enforcement ──────────────────────────────────────────

describe('POST /api/oauth/token grant_types enforcement', () => {
  it('rejects client_credentials from a public client with unauthorized_client', async () => {
    mockSql.mockResolvedValue({
      rows: [
        makeClientRow({
          client_secret_hash: null,
          redirect_uris: ['https://app.example.com/cb'],
          grant_types: ['authorization_code', 'refresh_token'],
        }),
      ],
    });

    const res = await tokenPost(
      tokenRequest({ client_id: 'client-123', grant_type: 'client_credentials' }),
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(body['error']).toBe('unauthorized_client');
    expect(body['access_token']).toBeUndefined();
  });

  it('rejects authorization_code from a client_credentials-only client', async () => {
    mockSql.mockResolvedValue({
      rows: [
        makeClientRow({
          client_secret_hash: hashClientSecret('svc-secret'),
          grant_types: ['client_credentials'],
          token_endpoint_auth_method: 'client_secret_post',
        }),
      ],
    });

    const res = await tokenPost(
      tokenRequest({
        client_id: 'client-123',
        client_secret: 'svc-secret',
        grant_type: 'authorization_code',
        code: 'x',
        redirect_uri: 'https://app.example.com/cb',
        code_verifier: 'y',
      }),
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(body['error']).toBe('unauthorized_client');
  });

  it('still reports unsupported_grant_type for a grant this server does not implement', async () => {
    mockSql.mockResolvedValue({
      rows: [makeClientRow({ redirect_uris: ['https://app.example.com/cb'] })],
    });

    const res = await tokenPost(tokenRequest({ client_id: 'client-123', grant_type: 'password' }));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(body['error']).toBe('unsupported_grant_type');
  });

  it('issues a token for a confidential client registered for client_credentials', async () => {
    mockSql.mockResolvedValue({
      rows: [
        makeClientRow({
          client_secret_hash: hashClientSecret('svc-secret'),
          grant_types: ['client_credentials'],
          token_endpoint_auth_method: 'client_secret_post',
        }),
      ],
    });

    const res = await tokenPost(
      tokenRequest({
        client_id: 'client-123',
        client_secret: 'svc-secret',
        grant_type: 'client_credentials',
      }),
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body['access_token']).toBeTruthy();
    expect(body['scope']).toBe('mcp:read');
  });

  it('issues a token for a LEGACY confidential client stored without client_credentials', async () => {
    // Registered before grant_types were honoured: stored grants are the old
    // hardcoded pair, but it has a secret and no redirect_uris.
    mockSql.mockResolvedValue({
      rows: [
        makeClientRow({
          client_secret_hash: hashClientSecret('legacy-secret'),
          grant_types: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_method: 'client_secret_post',
        }),
      ],
    });

    const res = await tokenPost(
      tokenRequest({
        client_id: 'client-123',
        client_secret: 'legacy-secret',
        grant_type: 'client_credentials',
      }),
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body['access_token']).toBeTruthy();
  });
});

// ── RFC 7592 management endpoint ──────────────────────────────────────────────

describe('GET/DELETE /api/oauth/register/[client_id]', () => {
  const params = Promise.resolve({ client_id: 'client-123' });
  const managedRow = () =>
    makeClientRow({
      redirect_uris: ['https://app.example.com/cb'],
      registration_access_token_hash: hashClientSecret('mgmt-token'),
    });

  it('findClientRegistration exposes the stored management token hash', async () => {
    mockSql.mockResolvedValue({ rows: [managedRow()] });

    const reg = await findClientRegistration('client-123');

    expect(reg?.registrationAccessTokenHash).toBe(hashClientSecret('mgmt-token'));
    expect(reg?.clientIdIssuedAt).toBe(Math.floor(Date.parse('2026-01-01T00:00:00.000Z') / 1000));
  });

  it('GET returns the client metadata for a valid registration access token', async () => {
    mockSql.mockResolvedValue({ rows: [managedRow()] });

    const res = await manageGet(manageRequest('GET', { authorization: 'Bearer mgmt-token' }), {
      params,
    });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body['client_id']).toBe('client-123');
    expect(body['grant_types']).toEqual(['authorization_code', 'refresh_token']);
    expect(body['registration_client_uri']).toBe(
      'http://localhost:3001/api/oauth/register/client-123',
    );
    expect(body['client_secret']).toBeUndefined();
  });

  it('GET rejects a missing Authorization header with 401 invalid_token', async () => {
    mockSql.mockResolvedValue({ rows: [managedRow()] });

    const res = await manageGet(manageRequest('GET'), { params });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(401);
    expect(body['error']).toBe('invalid_token');
  });

  it('GET rejects a wrong registration access token', async () => {
    mockSql.mockResolvedValue({ rows: [managedRow()] });

    const res = await manageGet(manageRequest('GET', { authorization: 'Bearer wrong-token' }), {
      params,
    });

    expect(res.status).toBe(401);
  });

  it('GET returns 401 for an unknown or already-revoked client', async () => {
    mockSql.mockResolvedValue({ rows: [] });

    const res = await manageGet(manageRequest('GET', { authorization: 'Bearer mgmt-token' }), {
      params,
    });

    expect(res.status).toBe(401);
  });

  it('GET returns 401 for a client registered before management tokens existed', async () => {
    mockSql.mockResolvedValue({
      rows: [makeClientRow({ registration_access_token_hash: null })],
    });

    const res = await manageGet(manageRequest('GET', { authorization: 'Bearer mgmt-token' }), {
      params,
    });

    expect(res.status).toBe(401);
  });

  it('DELETE revokes the client and returns 204', async () => {
    mockSql.mockResolvedValue({ rows: [managedRow()], rowCount: 1 });

    const res = await manageDelete(
      manageRequest('DELETE', { authorization: 'Bearer mgmt-token' }),
      { params },
    );

    expect(res.status).toBe(204);
    // One SELECT to authorize, one UPDATE to revoke.
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('DELETE without a valid token does not revoke anything', async () => {
    mockSql.mockResolvedValue({ rows: [managedRow()], rowCount: 1 });

    const res = await manageDelete(manageRequest('DELETE', { authorization: 'Bearer nope' }), {
      params,
    });

    expect(res.status).toBe(401);
    expect(mockSql).toHaveBeenCalledTimes(1);
  });
});
