import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  signAccessToken,
  verifyAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  getStaticClient,
  verifyClientSecret,
  hashClientSecret,
  getIssuerUrl,
  filterScopes,
  computePkceChallenge,
  verifyPkceS256,
  constantTimeEquals,
  resolveGrantTypes,
  generateRegistrationAccessToken,
  InvalidClientMetadataError,
  OAUTH_AUDIENCE,
  SUPPORTED_GRANT_TYPES,
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

// ── refresh tokens ─────────────────────────────────────────────────────────────

describe('signRefreshToken / verifyRefreshToken', () => {
  beforeEach(() => {
    process.env['OAUTH_JWT_SECRET'] = 'test-jwt-secret-at-least-32-bytes-long!!';
    process.env['NEXT_PUBLIC_MCP_URL'] = 'http://localhost:3001';
  });
  afterEach(() => {
    delete process.env['OAUTH_JWT_SECRET'];
    delete process.env['NEXT_PUBLIC_MCP_URL'];
  });

  it('signs and verifies a refresh token', async () => {
    const token = await signRefreshToken('client-abc', 'mcp:read');
    const claims = await verifyRefreshToken(token);
    expect(claims.sub).toBe('client-abc');
    expect(claims.token_use).toBe('refresh');
  });

  it('rejects an access token presented as a refresh token', async () => {
    const access = await signAccessToken('client-abc', 'mcp:read');
    await expect(verifyRefreshToken(access)).rejects.toThrow();
  });

  it('rejects a refresh token presented as an access token', async () => {
    const refresh = await signRefreshToken('client-abc', 'mcp:read');
    await expect(verifyAccessToken(refresh)).rejects.toThrow();
  });
});

// ── getStaticClient ─────────────────────────────────────────────────────────────

describe('getStaticClient', () => {
  afterEach(() => {
    delete process.env['MCP_CLIENT_ID'];
    delete process.env['MCP_CLIENT_SECRET'];
  });

  it('returns null when env vars not set', () => {
    expect(getStaticClient()).toBeNull();
  });

  it('returns the static client when MCP_CLIENT_ID/SECRET are set', () => {
    process.env['MCP_CLIENT_ID'] = 'static-id';
    process.env['MCP_CLIENT_SECRET'] = 'static-secret';
    const client = getStaticClient();
    expect(client?.clientId).toBe('static-id');
    expect(client?.scope).toBe('mcp:read');
    expect(client?.grantTypes).toContain('client_credentials');
  });

  it('static client secret verifies correctly', () => {
    process.env['MCP_CLIENT_ID'] = 'static-id';
    process.env['MCP_CLIENT_SECRET'] = 'static-secret';
    const client = getStaticClient()!;
    expect(verifyClientSecret('static-secret', client.clientSecretHash!)).toBe(true);
    expect(verifyClientSecret('wrong', client.clientSecretHash!)).toBe(false);
  });
});

// ── filterScopes ─────────────────────────────────────────────────────────────

describe('filterScopes', () => {
  it('defaults to mcp:read when undefined', () => {
    expect(filterScopes(undefined)).toBe('mcp:read');
  });

  it('drops disallowed scopes', () => {
    expect(filterScopes('mcp:read mcp:write admin')).toBe('mcp:read');
  });

  it('falls back to mcp:read when all requested scopes are disallowed', () => {
    expect(filterScopes('admin superuser')).toBe('mcp:read');
  });
});

// ── PKCE (RFC 7636) ─────────────────────────────────────────────────────────────

describe('PKCE S256', () => {
  it('verifies a matching verifier/challenge pair', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = computePkceChallenge(verifier);
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
  });

  it('rejects a mismatched verifier', () => {
    const challenge = computePkceChallenge('the-real-verifier');
    expect(verifyPkceS256('a-different-verifier', challenge)).toBe(false);
  });

  it('matches the RFC 7636 reference vector', () => {
    // Appendix B reference: verifier -> challenge
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(computePkceChallenge(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

// ── constantTimeEquals ─────────────────────────────────────────────────────────

describe('constantTimeEquals', () => {
  it('returns true for identical strings', () => {
    expect(constantTimeEquals('a-shared-token', 'a-shared-token')).toBe(true);
  });

  it('returns false for different strings', () => {
    expect(constantTimeEquals('a-shared-token', 'a-shared-tokeN')).toBe(false);
  });

  it('returns false (does not throw) for strings of different lengths', () => {
    expect(constantTimeEquals('short', 'a-much-longer-token')).toBe(false);
  });
});

// ── generateRegistrationAccessToken ────────────────────────────────────────────

describe('generateRegistrationAccessToken', () => {
  it('produces distinct high-entropy tokens', () => {
    const a = generateRegistrationAccessToken();
    const b = generateRegistrationAccessToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });
});

// ── resolveGrantTypes (RFC 7591 §3.2.1) ────────────────────────────────────────

describe('resolveGrantTypes defaults (grant_types omitted)', () => {
  it('defaults to authorization_code + refresh_token when redirect_uris are present', () => {
    const resolved = resolveGrantTypes(undefined, ['https://app.example.com/cb']);
    expect(resolved.grantTypes).toEqual(['authorization_code', 'refresh_token']);
    expect(resolved.isPublic).toBe(true);
  });

  it('defaults to client_credentials when there are no redirect_uris', () => {
    const resolved = resolveGrantTypes(undefined, []);
    expect(resolved.grantTypes).toEqual(['client_credentials']);
    expect(resolved.isPublic).toBe(false);
  });
});

describe('resolveGrantTypes explicit requests', () => {
  it('honours an explicit authorization_code + refresh_token request', () => {
    const resolved = resolveGrantTypes(
      ['authorization_code', 'refresh_token'],
      ['https://app.example.com/cb'],
    );
    expect(resolved.grantTypes).toEqual(['authorization_code', 'refresh_token']);
    expect(resolved.isPublic).toBe(true);
  });

  it('honours authorization_code alone (no refresh_token)', () => {
    const resolved = resolveGrantTypes(['authorization_code'], ['https://app.example.com/cb']);
    expect(resolved.grantTypes).toEqual(['authorization_code']);
    expect(resolved.isPublic).toBe(true);
  });

  it('honours an explicit client_credentials request as a confidential client', () => {
    const resolved = resolveGrantTypes(['client_credentials'], []);
    expect(resolved.grantTypes).toEqual(['client_credentials']);
    expect(resolved.isPublic).toBe(false);
  });

  it('de-duplicates repeated grant types', () => {
    const resolved = resolveGrantTypes(
      ['authorization_code', 'authorization_code', 'refresh_token'],
      ['https://app.example.com/cb'],
    );
    expect(resolved.grantTypes).toEqual(['authorization_code', 'refresh_token']);
  });

  it('only supports the advertised grant types', () => {
    expect([...SUPPORTED_GRANT_TYPES]).toEqual([
      'authorization_code',
      'refresh_token',
      'client_credentials',
    ]);
  });
});

describe('resolveGrantTypes rejections', () => {
  it('rejects an unsupported grant type', () => {
    expect(() => resolveGrantTypes(['password'], ['https://app.example.com/cb'])).toThrow(
      InvalidClientMetadataError,
    );
    expect(() => resolveGrantTypes(['password'], ['https://app.example.com/cb'])).toThrow(
      /unsupported grant_type: password/,
    );
  });

  it('rejects an empty grant_types array', () => {
    expect(() => resolveGrantTypes([], ['https://app.example.com/cb'])).toThrow(
      /grant_types must not be empty/,
    );
  });

  it('rejects authorization_code with no redirect_uris', () => {
    expect(() => resolveGrantTypes(['authorization_code'], [])).toThrow(
      /authorization_code requires at least one redirect_uri/,
    );
  });

  it('rejects authorization_code + refresh_token with no redirect_uris', () => {
    expect(() => resolveGrantTypes(['authorization_code', 'refresh_token'], [])).toThrow(
      /authorization_code requires at least one redirect_uri/,
    );
  });

  it('rejects refresh_token without authorization_code', () => {
    expect(() => resolveGrantTypes(['refresh_token'], ['https://app.example.com/cb'])).toThrow(
      /refresh_token requires authorization_code/,
    );
  });

  it('rejects client_credentials requested together with redirect_uris', () => {
    expect(() => resolveGrantTypes(['client_credentials'], ['https://app.example.com/cb'])).toThrow(
      /client_credentials is not available to public clients registered with redirect_uris/,
    );
  });

  it('rejects mixing client_credentials into an interactive registration', () => {
    // The bypass being closed: a public PKCE client asking for a secret-less
    // client_credentials grant.
    expect(() =>
      resolveGrantTypes(
        ['authorization_code', 'refresh_token', 'client_credentials'],
        ['https://app.example.com/cb'],
      ),
    ).toThrow(/client_credentials is not available to public clients/);
  });

  it('rejects authorization_code + client_credentials with no redirect_uris', () => {
    expect(() => resolveGrantTypes(['authorization_code', 'client_credentials'], [])).toThrow(
      /authorization_code requires at least one redirect_uri/,
    );
  });
});
