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
    vi.stubEnv('NEXT_PUBLIC_MCP_URL', '');
    vi.stubEnv('ADMIN_SESSION_SECRET', 'session-secret');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('returns 503 when auth env is not fully configured', async () => {
    vi.stubEnv('ADMIN_SESSION_SECRET', '');
    const { POST } = await import('../app/api/admin/login/route');
    const res = await POST(
      makePostRequest({ username: 'admin', password: 'super-secret' }) as never
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Auth not configured');
  });

  it('returns 401 when apps/mcp rejects credentials', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: 'Invalid username or password' }), { status: 401 })
        )
    );
    const { POST } = await import('../app/api/admin/login/route');
    const res = await POST(
      makePostRequest({ username: 'wrong', password: 'super-secret' }) as never
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Invalid username or password');
  });

  it('returns 200 and sets a session cookie for valid credentials', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { POST } = await import('../app/api/admin/login/route');
    const res = await POST(
      makePostRequest({ username: 'admin', password: 'super-secret' }) as never
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3001/api/admin/login',
      expect.objectContaining({ method: 'POST' })
    );
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain('admin_session=');
  });
});
