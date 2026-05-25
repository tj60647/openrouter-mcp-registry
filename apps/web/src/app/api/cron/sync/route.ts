import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const mcpBase = () =>
  (process.env['MCP_URL'] ?? process.env['NEXT_PUBLIC_MCP_URL'] ?? 'http://localhost:3001').replace(/\/$/, '');

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Validate cron secret before forwarding.
  const cronSecret = process.env['CRON_SECRET'];
  if (cronSecret) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const headers: Record<string, string> = {};
    if (cronSecret) headers['Authorization'] = `Bearer ${cronSecret}`;
    const res = await fetch(`${mcpBase()}/api/cron/sync`, { headers });
    const data: unknown = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
