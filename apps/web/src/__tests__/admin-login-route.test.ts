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
    vi.stubEnv('ADMIN_USERNAME', 'admin');
    vi.stubEnv('ADMIN_SECRET', 'super-secret');
    vi.stubEnv('ADMIN_SESSION_SECRET', 'session-secret');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 503 when auth env is not fully configured', async () => {
    vi.stubEnv('ADMIN_SECRET', '');
    const { POST } = await import('../app/api/admin/login/route');
    const res = await POST(makePostRequest({ username: 'admin', password: 'super-secret' }) as never);
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Auth not configured');
  });

  it('returns 401 for an invalid username', async () => {
    const { POST } = await import('../app/api/admin/login/route');
    const res = await POST(makePostRequest({ username: 'wrong', password: 'super-secret' }) as never);
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Invalid username or password');
  });

  it('returns 401 for an invalid password', async () => {
    const { POST } = await import('../app/api/admin/login/route');
    const res = await POST(makePostRequest({ username: 'admin', password: 'wrong' }) as never);
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Invalid username or password');
  });

  it('returns 200 and sets a session cookie for valid credentials', async () => {
    const { POST } = await import('../app/api/admin/login/route');
    const res = await POST(makePostRequest({ username: 'admin', password: 'super-secret' }) as never);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain('admin_session=');
  });
});
