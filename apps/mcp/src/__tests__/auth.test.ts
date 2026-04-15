import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { validateAdminToken, validateMcpToken } from '../lib/auth';

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
});

describe('validateMcpToken', () => {
  it('returns null when MCP_API_KEY is not set (open)', () => {
    delete process.env['MCP_API_KEY'];
    const req = new NextRequest('http://localhost/api/mcp');
    const result = validateMcpToken(req);
    expect(result).toBeNull();
  });

  it('returns null for valid MCP token', () => {
    process.env['MCP_API_KEY'] = 'mcp-key';
    const req = new NextRequest('http://localhost/api/mcp', {
      headers: { authorization: 'Bearer mcp-key' },
    });
    const result = validateMcpToken(req);
    delete process.env['MCP_API_KEY'];
    expect(result).toBeNull();
  });

  it('returns 401 for invalid MCP token', () => {
    process.env['MCP_API_KEY'] = 'mcp-key';
    const req = new NextRequest('http://localhost/api/mcp', {
      headers: { authorization: 'Bearer wrong' },
    });
    const result = validateMcpToken(req);
    delete process.env['MCP_API_KEY'];
    expect(result?.status).toBe(401);
  });
});
