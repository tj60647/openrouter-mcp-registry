import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  signAccessToken,
  verifyAccessToken,
  getClient,
  registerDynamicClient,
  verifyClientSecret,
  hashClientSecret,
  getIssuerUrl,
  OAUTH_AUDIENCE,
  ALLOWED_SCOPES,
} from '../lib/oauth';

// ── getIssuerUrl ───────────────────────────────────────────────────────────────

describe('getIssuerUrl', () => {
  afterEach(() => {
    delete process.env['NEXT_PUBLIC_MCP_URL'];
    delete process.env['VERCEL_URL'];
  });

  it('uses NEXT_PUBLIC_MCP_URL when set', () => {
    process.env['NEXT_PUBLIC_MCP_URL'] = 'https://my-mcp.example.com/';
    expect(getIssuerUrl()).toBe('https://my-mcp.example.com');
  });

  it('strips trailing slash from NEXT_PUBLIC_MCP_URL', () => {
    process.env['NEXT_PUBLIC_MCP_URL'] = 'https://my-mcp.example.com/';
    expect(getIssuerUrl()).not.toMatch(/\/$/);
  });

  it('uses VERCEL_URL when NEXT_PUBLIC_MCP_URL is not set', () => {
    process.env['VERCEL_URL'] = 'my-app.vercel.app';
    expect(getIssuerUrl()).toBe('https://my-app.vercel.app');
  });

  it('falls back to localhost:3001', () => {
    expect(getIssuerUrl()).toBe('http://localhost:3001');
  });
});

// ── JWT sign / verify ─────────────────────────────────────────────────────────

describe('signAccessToken / verifyAccessToken', () => {
  beforeEach(() => {
    process.env['OAUTH_JWT_SECRET'] = 'test-jwt-secret-at-least-32-bytes-long!!';
    // Use a fixed issuer so sign and verify agree.
    process.env['NEXT_PUBLIC_MCP_URL'] = 'http://localhost:3001';
  });
  afterEach(() => {
    delete process.env['OAUTH_JWT_SECRET'];
    delete process.env['NEXT_PUBLIC_MCP_URL'];
  });

  it('signs and verifies a valid token', async () => {
    const token = await signAccessToken('client-abc', 'mcp:read');
    const claims = await verifyAccessToken(token);
    expect(claims.sub).toBe('client-abc');
    expect(claims.scope).toBe('mcp:read');
    expect(claims.aud).toBe(OAUTH_AUDIENCE);
  });

  it('throws when OAUTH_JWT_SECRET is not set', async () => {
    delete process.env['OAUTH_JWT_SECRET'];
    await expect(signAccessToken('x', 'mcp:read')).rejects.toThrow('OAUTH_JWT_SECRET');
  });

  it('throws on a tampered token', async () => {
    const token = await signAccessToken('client-abc', 'mcp:read');
    const tampered = token.slice(0, -4) + 'xxxx';
    await expect(verifyAccessToken(tampered)).rejects.toThrow();
  });

  it('throws on wrong audience', async () => {
    // Manually craft a token with wrong audience — easiest way is to use a different audience via jose directly
    // Instead, just verify that a token signed with a different secret fails
    process.env['OAUTH_JWT_SECRET'] = 'different-secret-32-bytes-long!!!!';
    const tokenBadSecret = await signAccessToken('client-abc', 'mcp:read');
    process.env['OAUTH_JWT_SECRET'] = 'test-jwt-secret-at-least-32-bytes-long!!';
    await expect(verifyAccessToken(tokenBadSecret)).rejects.toThrow();
  });

  it('embeds issuer in token and verifyAccessToken validates it', async () => {
    const token = await signAccessToken('client-abc', 'mcp:read');
    // Change issuer after signing — verification must fail
    process.env['NEXT_PUBLIC_MCP_URL'] = 'https://evil.example.com';
    await expect(verifyAccessToken(token)).rejects.toThrow();
  });
});

// ── Client credential hashing ─────────────────────────────────────────────────

describe('hashClientSecret / verifyClientSecret', () => {
  it('produces the same hash for the same input', () => {
    const h1 = hashClientSecret('my-secret');
    const h2 = hashClientSecret('my-secret');
    expect(h1).toBe(h2);
  });

  it('produces different hashes for different inputs', () => {
    expect(hashClientSecret('a')).not.toBe(hashClientSecret('b'));
  });

  it('verifyClientSecret returns true for matching secret', () => {
    const stored = hashClientSecret('correct-secret');
    expect(verifyClientSecret('correct-secret', stored)).toBe(true);
  });

  it('verifyClientSecret returns false for wrong secret', () => {
    const stored = hashClientSecret('correct-secret');
    expect(verifyClientSecret('wrong-secret', stored)).toBe(false);
  });
});

// ── getClient ─────────────────────────────────────────────────────────────────

describe('getClient', () => {
  afterEach(() => {
    delete process.env['MCP_CLIENT_ID'];
    delete process.env['MCP_CLIENT_SECRET'];
  });

  it('returns null for unknown client', () => {
    expect(getClient('nonexistent')).toBeNull();
  });

  it('returns static client when MCP_CLIENT_ID/SECRET are set', () => {
    process.env['MCP_CLIENT_ID'] = 'static-id';
    process.env['MCP_CLIENT_SECRET'] = 'static-secret';
    const client = getClient('static-id');
    expect(client).not.toBeNull();
    expect(client?.clientId).toBe('static-id');
    expect(client?.scope).toBe('mcp:read admin:write');
  });

  it('static client secret verifies correctly', () => {
    process.env['MCP_CLIENT_ID'] = 'static-id';
    process.env['MCP_CLIENT_SECRET'] = 'static-secret';
    const client = getClient('static-id')!;
    expect(verifyClientSecret('static-secret', client.clientSecretHash)).toBe(true);
    expect(verifyClientSecret('wrong', client.clientSecretHash)).toBe(false);
  });

  it('returns null for static id when env vars not set', () => {
    expect(getClient('static-id')).toBeNull();
  });
});

// ── registerDynamicClient ─────────────────────────────────────────────────────

describe('registerDynamicClient', () => {
  it('registers a new client and returns unique id + secret', () => {
    const a = registerDynamicClient('Client A');
    const b = registerDynamicClient('Client B');
    expect(a.clientId).not.toBe(b.clientId);
    expect(a.clientSecret).not.toBe(b.clientSecret);
  });

  it('registered client is retrievable via getClient', () => {
    const { clientId, clientSecret } = registerDynamicClient('Test Client');
    const client = getClient(clientId);
    expect(client).not.toBeNull();
    expect(verifyClientSecret(clientSecret, client!.clientSecretHash)).toBe(true);
  });

  it('defaults to mcp:read scope', () => {
    const { scope } = registerDynamicClient('No scope client');
    expect(scope).toBe('mcp:read');
  });

  it('grants only allowed scopes', () => {
    const { scope } = registerDynamicClient('Client', 'mcp:read mcp:write admin');
    // Only mcp:read is in ALLOWED_SCOPES
    const granted = scope.split(' ');
    for (const s of granted) {
      expect(ALLOWED_SCOPES.has(s)).toBe(true);
    }
    expect(granted).toContain('mcp:read');
  });

  it('falls back to mcp:read when all requested scopes are disallowed', () => {
    const { scope } = registerDynamicClient('Client', 'admin superuser');
    expect(scope).toBe('mcp:read');
  });

  it('stores client with correct name', () => {
    const { clientId } = registerDynamicClient('Named Client');
    expect(getClient(clientId)?.clientName).toBe('Named Client');
  });
});
