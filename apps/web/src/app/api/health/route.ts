import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const mcpBase = () =>
  (process.env['MCP_URL'] ?? process.env['NEXT_PUBLIC_MCP_URL'] ?? 'http://localhost:3001').replace(
    /\/+$/,
    ''
  );

/**
 * Proxies the MCP host's health check. The upstream status is passed through
 * unchanged, so a 503 from apps/mcp stays a 503 here.
 *
 * The timeout matters: without it a hung MCP host hangs this check rather than
 * failing it, and a monitor waiting on a request that never returns reports
 * nothing at all.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const res = await fetch(`${mcpBase()}/api/health`, { signal: AbortSignal.timeout(10_000) });
    const data: unknown = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    // 503, not 200. Reaching here means the MCP host is unreachable, timed out,
    // or returned a body this route could not parse — for example a platform
    // HTML error page, which would otherwise be laundered into a 200.
    return NextResponse.json(
      { status: 'degraded', error: message, timestamp: new Date().toISOString() },
      { status: 503 }
    );
  }
}
