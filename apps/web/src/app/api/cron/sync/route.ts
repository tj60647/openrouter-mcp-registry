import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    {
      error: 'Cron sync is owned by apps/mcp. Configure Vercel cron on the MCP app only.',
    },
    { status: 410 }
  );
}
