import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { validateAdminToken } from '../lib/auth';

describe('validateAdminToken', () => {
  beforeEach(() => {
    process.env['ADMIN_SECRET'] = 'test-secret';
  });
  afterEach(() => {
    delete process.env['ADMIN_SECRET'];
  });

  it('returns null for valid token', () => {
    const req = new NextRequest('http://localhost/api/admin/refresh', {
      headers: { authorization: 'Bearer test-secret' },
    });
    const result = validateAdminToken(req);
    expect(result).toBeNull();
  });

  it('returns 401 for invalid token', () => {
    const req = new NextRequest('http://localhost/api/admin/refresh', {
      headers: { authorization: 'Bearer wrong-token' },
    });
    const result = validateAdminToken(req);
    expect(result?.status).toBe(401);
  });

  it('returns 401 for missing token', () => {
    const req = new NextRequest('http://localhost/api/admin/refresh');
    const result = validateAdminToken(req);
    expect(result?.status).toBe(401);
  });

  it('returns 503 when ADMIN_SECRET is not configured', () => {
    delete process.env['ADMIN_SECRET'];
    const req = new NextRequest('http://localhost/api/admin/refresh', {
      headers: { authorization: 'Bearer any-value' },
    });
    const result = validateAdminToken(req);
    expect(result?.status).toBe(503);
  });
});
