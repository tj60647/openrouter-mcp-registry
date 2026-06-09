import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { validateAdminToken } from '../lib/auth';
import { signAccessToken } from '../lib/oauth';

describe('validateAdminToken', () => {
  beforeEach(() => {
    process.env['ADMIN_SECRET'] = 'test-secret';
  });
  afterEach(() => {
    delete process.env['ADMIN_SECRET'];
    delete process.env['OAUTH_JWT_SECRET'];
    delete process.env['NEXT_PUBLIC_MCP_URL'];
  });

  it('returns null for valid ADMIN_SECRET token', async () => {
    const req = new NextRequest('http://localhost/api/admin/refresh', {
      headers: { authorization: 'Bearer test-secret' },
    });
    const result = await validateAdminToken(req);
    expect(result).toBeNull();
  });

  it('returns null for valid OAuth admin:write token', async () => {
    process.env['OAUTH_JWT_SECRET'] = 'test-jwt-secret-at-least-32-bytes-long!!';
    process.env['NEXT_PUBLIC_MCP_URL'] = 'http://localhost:3001';
    const token = await signAccessToken('web-client', 'admin:write');
    const req = new NextRequest('http://localhost/api/admin/refresh', {
      headers: { authorization: `Bearer ${token}` },
    });
    const result = await validateAdminToken(req);
    expect(result).toBeNull();
  });

  it('returns 401 for OAuth token without admin:write scope', async () => {
    process.env['OAUTH_JWT_SECRET'] = 'test-jwt-secret-at-least-32-bytes-long!!';
    process.env['NEXT_PUBLIC_MCP_URL'] = 'http://localhost:3001';
    const token = await signAccessToken('web-client', 'mcp:read');
    const req = new NextRequest('http://localhost/api/admin/refresh', {
      headers: { authorization: `Bearer ${token}` },
    });
    const result = await validateAdminToken(req);
    expect(result?.status).toBe(401);
  });

  it('returns 401 for invalid token', async () => {
    const req = new NextRequest('http://localhost/api/admin/refresh', {
      headers: { authorization: 'Bearer wrong-token' },
    });
    const result = await validateAdminToken(req);
    expect(result?.status).toBe(401);
  });

  it('returns 401 for missing token', async () => {
    const req = new NextRequest('http://localhost/api/admin/refresh');
    const result = await validateAdminToken(req);
    expect(result?.status).toBe(401);
  });

  it('returns 503 when no admin auth mechanism is configured', async () => {
    delete process.env['ADMIN_SECRET'];
    const req = new NextRequest('http://localhost/api/admin/refresh', {
      headers: { authorization: 'Bearer any-value' },
    });
    const result = await validateAdminToken(req);
    expect(result?.status).toBe(503);
  });
});
