/**
 * @file well-known.test.ts
 * Tests for the two OAuth discovery documents: the RFC 8414 authorization
 * server metadata at /.well-known/oauth-authorization-server and the RFC 9728
 * protected resource metadata at /.well-known/oauth-protected-resource. Every
 * MCP client reads these before it can authenticate at all, so a wrong endpoint,
 * a drifted grant list, or an issuer that does not match between the two
 * documents breaks every client at once rather than one code path. The
 * mcp-handler package is mocked so the protected-resource route's construction
 * arguments can be inspected without asserting anything about the library.
 *
 * Author: Thomas J McLeish
 * License: MIT
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock mcp-handler ──────────────────────────────────────────────────────────
// vi.hoisted is required because vi.mock factories are hoisted above const
// declarations. The protected-resource route calls protectedResourceHandler at
// module scope, so the only way to see what it was configured with is to
// capture the call.

const { mockProtectedResourceHandler, mockCorsOptionsHandler } = vi.hoisted(() => {
  const resourceHandler = (): Response => new Response(null, { status: 200 });
  const corsHandler = (): Response => new Response(null, { status: 204 });
  return {
    mockProtectedResourceHandler: vi.fn<
      [{ authServerUrls: string[]; resourceUrl?: string }],
      () => Response
    >(() => resourceHandler),
    mockCorsOptionsHandler: vi.fn(() => corsHandler),
  };
});

vi.mock('mcp-handler', () => ({
  protectedResourceHandler: mockProtectedResourceHandler,
  metadataCorsOptionsRequestHandler: mockCorsOptionsHandler,
}));

// ── Imports under test (after mock registration) ─────────────────────────────
// The authorization-server route reads env inside GET, so a static import is
// safe. The protected-resource route reads it at module scope and is therefore
// loaded per test via loadProtectedResource().

import { SUPPORTED_GRANT_TYPES, ALLOWED_SCOPES } from '../lib/oauth';
import { GET as authServerGet } from '../app/.well-known/oauth-authorization-server/route';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ISSUER = 'https://mcp.example.com';

async function readAuthServerMetadata(): Promise<Record<string, unknown>> {
  const res = await authServerGet();
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Re-evaluates the protected-resource route against the currently stubbed env
 * and returns both its exports and the options it handed to mcp-handler.
 */
async function loadProtectedResource(): Promise<{
  GET: unknown;
  OPTIONS: unknown;
  options: { authServerUrls: string[]; resourceUrl?: string };
}> {
  mockProtectedResourceHandler.mockClear();
  mockCorsOptionsHandler.mockClear();
  vi.resetModules();
  const route = await import('../app/.well-known/oauth-protected-resource/route');
  const options = mockProtectedResourceHandler.mock.calls[0]?.[0];
  if (!options) throw new Error('protectedResourceHandler was never called');
  return { GET: route.GET, OPTIONS: route.OPTIONS, options };
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_MCP_URL', ISSUER);
  vi.stubEnv('VERCEL_URL', '');
  vi.stubEnv('OAUTH_DISABLE_REGISTRATION', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── RFC 8414 document shape ───────────────────────────────────────────────────

describe('GET /.well-known/oauth-authorization-server', () => {
  it('serves the discovery document to unauthenticated callers', async () => {
    const res = await authServerGet();

    // Discovery precedes any credential, so a 401/403 here would deadlock every
    // client: it cannot get a token without first reading this document.
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('names the deployment issuer as the issuer', async () => {
    const body = await readAuthServerMetadata();

    expect(body['issuer']).toBe(ISSUER);
  });

  it('points clients at the authorize and token endpoints this server implements', async () => {
    const body = await readAuthServerMetadata();

    expect(body['authorization_endpoint']).toBe(`${ISSUER}/api/oauth/authorize`);
    expect(body['token_endpoint']).toBe(`${ISSUER}/api/oauth/token`);
  });

  it('advertises the authorization-code response type and no implicit flow', async () => {
    const body = await readAuthServerMetadata();

    expect(body['response_types_supported']).toEqual(['code']);
    // OAuth 2.1 removed the implicit grant; advertising it would invite clients
    // to ask for tokens straight off the redirect.
    expect(body['response_types_supported']).not.toContain('token');
  });

  it('accepts the client authentication methods the token endpoint understands', async () => {
    const body = await readAuthServerMetadata();

    expect(body['token_endpoint_auth_methods_supported']).toEqual([
      'client_secret_post',
      'client_secret_basic',
      'none',
    ]);
  });

  it('offers only scopes this server is willing to grant', async () => {
    const body = await readAuthServerMetadata();

    const advertised = body['scopes_supported'] as string[];
    expect(advertised).toEqual(['mcp:read']);
    // A scope advertised here but missing from ALLOWED_SCOPES would be silently
    // stripped by filterScopes, leaving the client convinced it holds it.
    expect(advertised.filter((scope) => !ALLOWED_SCOPES.has(scope))).toEqual([]);
  });
});

// ── Advertised grants must not drift from enforced grants ─────────────────────
// The metadata document and the registration/token enforcement path share
// SUPPORTED_GRANT_TYPES for exactly this reason. Asserting against a literal
// list here would pass happily while the two halves diverged.

describe('grant_types_supported', () => {
  it('advertises exactly the grants the token endpoint is prepared to accept', async () => {
    const body = await readAuthServerMetadata();

    expect(body['grant_types_supported']).toEqual([...SUPPORTED_GRANT_TYPES]);
  });

  it('publishes a copy rather than the shared constant itself', async () => {
    const body = await readAuthServerMetadata();

    // Handing out the live array would let a mutation of the response body
    // rewrite what the token endpoint enforces.
    expect(body['grant_types_supported']).not.toBe(SUPPORTED_GRANT_TYPES);
  });
});

// ── PKCE ──────────────────────────────────────────────────────────────────────

describe('code_challenge_methods_supported', () => {
  it('requires the S256 code challenge and never offers plain', async () => {
    const body = await readAuthServerMetadata();

    const methods = body['code_challenge_methods_supported'] as string[];
    expect(methods).toContain('S256');
    // OAuth 2.1 forbids plain PKCE: a downgrade to it makes the verifier
    // interceptable in the authorization request itself.
    expect(methods).not.toContain('plain');
    expect(methods).toEqual(['S256']);
  });
});

// ── Dynamic registration gate ─────────────────────────────────────────────────

describe('registration_endpoint', () => {
  it('advertises dynamic client registration by default', async () => {
    const body = await readAuthServerMetadata();

    expect(body['registration_endpoint']).toBe(`${ISSUER}/api/oauth/register`);
  });

  it('withholds the registration endpoint when registration is disabled', async () => {
    vi.stubEnv('OAUTH_DISABLE_REGISTRATION', 'true');

    const body = await readAuthServerMetadata();

    // Absent, not null or empty string: RFC 8414 readers treat presence as the
    // signal, so a null would still advertise the capability to some clients.
    expect(body).not.toHaveProperty('registration_endpoint');
  });

  it('leaves the rest of the document intact when registration is disabled', async () => {
    vi.stubEnv('OAUTH_DISABLE_REGISTRATION', 'true');

    const body = await readAuthServerMetadata();

    expect(body['issuer']).toBe(ISSUER);
    expect(body['token_endpoint']).toBe(`${ISSUER}/api/oauth/token`);
    expect(body['grant_types_supported']).toEqual([...SUPPORTED_GRANT_TYPES]);
  });

  it('keeps registration advertised for any value other than the exact string "true"', async () => {
    // The gate is an exact string comparison. Pinning it stops a deployment
    // that set the flag to a truthy-looking '1' from believing registration is
    // off while it is still being advertised and served.
    for (const value of ['1', 'yes', 'TRUE', 'True', 'false', ' true']) {
      vi.stubEnv('OAUTH_DISABLE_REGISTRATION', value);

      const body = await readAuthServerMetadata();

      expect(body['registration_endpoint'], `OAUTH_DISABLE_REGISTRATION=${value}`).toBe(
        `${ISSUER}/api/oauth/register`,
      );
    }
  });
});

// ── Endpoints are absolute, on the issuer origin ──────────────────────────────

describe('endpoint URLs', () => {
  const endpointKeys = ['authorization_endpoint', 'token_endpoint', 'registration_endpoint'];

  it('publishes absolute URLs rather than paths relative to the document', async () => {
    const body = await readAuthServerMetadata();

    for (const key of endpointKeys) {
      const value = body[key] as string;
      // A client resolving '/api/oauth/token' against its own base would post
      // credentials somewhere other than this server.
      expect(value, key).not.toMatch(/^\//);
      expect(new URL(value).origin, key).toBe(ISSUER);
    }
  });

  it('does not double the separator when the configured URL has a trailing slash', async () => {
    vi.stubEnv('NEXT_PUBLIC_MCP_URL', 'https://mcp.example.com/');

    const body = await readAuthServerMetadata();

    expect(body['issuer']).toBe(ISSUER);
    for (const key of endpointKeys) {
      expect(body[key] as string, key).not.toContain('.com//');
    }
    expect(body['token_endpoint']).toBe(`${ISSUER}/api/oauth/token`);
  });

  it('follows the Vercel deployment URL when no explicit issuer is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_MCP_URL', '');
    vi.stubEnv('VERCEL_URL', 'registry-preview-abc123.vercel.app');

    const body = await readAuthServerMetadata();

    expect(body['issuer']).toBe('https://registry-preview-abc123.vercel.app');
    // A deployed instance handing out localhost endpoints is unreachable from
    // every client that is not the machine it runs on.
    expect(body['token_endpoint']).not.toContain('localhost');
    expect(body['authorization_endpoint']).toBe(
      'https://registry-preview-abc123.vercel.app/api/oauth/authorize',
    );
  });
});

// ── RFC 9728 protected resource metadata ──────────────────────────────────────
// mcp-handler builds and serves the document; what belongs to this repo is the
// configuration it is built with and the fact that both verbs are exported.

describe('/.well-known/oauth-protected-resource', () => {
  it('exports handlers for both GET and the CORS preflight', async () => {
    const route = await loadProtectedResource();

    expect(typeof route.GET).toBe('function');
    // Browser-based MCP clients preflight this document; without OPTIONS the
    // discovery fetch fails before GET is ever reached.
    expect(typeof route.OPTIONS).toBe('function');
    // Answering the preflight with the metadata handler would return the
    // document without the CORS headers the browser is asking for.
    expect(route.OPTIONS).not.toBe(route.GET);
  });

  it('directs clients to this deployment as their authorization server', async () => {
    const route = await loadProtectedResource();

    expect(route.options.authServerUrls).toEqual([ISSUER]);
  });

  it('names one authorization server and no other', async () => {
    const route = await loadProtectedResource();

    // A second entry would let a client choose which issuer to trust, and any
    // token it returned would still be presented here.
    expect(route.options.authServerUrls).toHaveLength(1);
  });

  it('leaves the resource identifier to be derived from the request', async () => {
    const route = await loadProtectedResource();

    // Pinning resourceUrl at build time would make every preview deployment
    // advertise the production resource identifier.
    expect(route.options.resourceUrl).toBeUndefined();
  });

  it('follows the deployment issuer rather than a hardcoded URL', async () => {
    vi.stubEnv('NEXT_PUBLIC_MCP_URL', '');
    vi.stubEnv('VERCEL_URL', 'registry-preview-abc123.vercel.app');

    const route = await loadProtectedResource();

    expect(route.options.authServerUrls).toEqual(['https://registry-preview-abc123.vercel.app']);
    expect(route.options.authServerUrls[0]).not.toContain('localhost');
  });

  it('advertises the issuer string byte-for-byte as the authorization server document does', async () => {
    // RFC 9728 requires this value to match the "issuer" of the authorization
    // server metadata exactly. A trailing slash surviving in one document but
    // not the other is the way that match silently breaks.
    vi.stubEnv('NEXT_PUBLIC_MCP_URL', 'https://mcp.example.com/');

    const route = await loadProtectedResource();
    const body = await readAuthServerMetadata();

    expect(route.options.authServerUrls[0]).toBe(body['issuer']);
  });
});
