import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken, SESSION_COOKIE, type SessionPayload } from './session';

/**
 * Guard for admin API route handlers. Returns the verified session payload, or
 * an `error` NextResponse (401) the caller should return immediately.
 */
export async function requireAdminSession(
  req: NextRequest,
): Promise<{ session: SessionPayload; error?: undefined } | { session?: undefined; error: NextResponse }> {
  const secret = process.env['ADMIN_SESSION_SECRET'];
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!secret || !token) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  const session = await verifySessionToken(token, secret);
  if (!session) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  return { session };
}

/**
 * Server-to-server fetch to an apps/mcp admin endpoint, authenticated with
 * ADMIN_SECRET. Returns null when the MCP URL or ADMIN_SECRET is not configured.
 */
export async function mcpAdminFetch(
  path: string,
  init?: RequestInit,
): Promise<Response | null> {
  const mcpUrl = (process.env['MCP_URL'] ?? process.env['NEXT_PUBLIC_MCP_URL'])?.replace(/\/+$/, '');
  const adminSecret = process.env['ADMIN_SECRET'];
  if (!mcpUrl || !adminSecret) return null;

  return fetch(`${mcpUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${adminSecret}`,
    },
  });
}
