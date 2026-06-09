import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function makePostRequest(body: unknown) {
  return new Request('http://localhost/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/admin/login', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('MCP_URL', 'http://localhost:3001');
    vi.stubEnv('ADMIN_SESSION_SECRET', 'session-secret');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true })));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('returns 503 when auth env is not fully configured', async () => {
    vi.stubEnv('MCP_URL', '');
    const { POST } = await import('../app/api/admin/login/route');
    const res = await POST(makePostRequest({ username: 'admin', password: 'super-secret' }) as never);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Auth not configured');
  });

  it('does not require POSTGRES_URL in apps/web runtime', async () => {
    vi.stubEnv('POSTGRES_URL', '');
    const { POST } = await import('../app/api/admin/login/route');
    const res = await POST(makePostRequest({ username: 'admin', password: 'super-secret' }) as never);
    expect(res.status).toBe(200);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      'http://localhost:3001/api/admin/verify-login',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('returns 401 when apps/mcp rejects credentials', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: false }, { status: 401 })));
    const { POST } = await import('../app/api/admin/login/route');
    const res = await POST(makePostRequest({ username: 'wrong', password: 'super-secret' }) as never);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Invalid username or password');
  });

  it('uses MCP_CLIENT_ID and MCP_CLIENT_SECRET server-side in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('MCP_CLIENT_ID', 'web-client');
    vi.stubEnv('MCP_CLIENT_SECRET', 'web-secret');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ access_token: 'jwt' }))
        .mockResolvedValueOnce(Response.json({ ok: true }))
    );

    const { POST } = await import('../app/api/admin/login/route');
    const res = await POST(makePostRequest({ username: 'admin', password: 'super-secret' }) as never);

    expect(res.status).toBe(200);
    expect(vi.mocked(fetch)).toHaveBeenNthCalledWith(
      1,
      'http://localhost:3001/api/oauth/token',
      expect.objectContaining({ body: expect.stringContaining('web-client') })
    );
    expect(vi.mocked(fetch)).toHaveBeenNthCalledWith(
      2,
      'http://localhost:3001/api/admin/verify-login',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer jwt' }) })
    );
  });

  it('returns 200 and sets a session cookie for valid credentials', async () => {
    const { POST } = await import('../app/api/admin/login/route');
    const res = await POST(makePostRequest({ username: 'admin', password: 'super-secret' }) as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain('admin_session=');
  });
});
