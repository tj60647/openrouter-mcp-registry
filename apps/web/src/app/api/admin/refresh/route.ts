import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(): Promise<NextResponse> {
  return NextResponse.json(
    {
      error:
        'Admin refresh is owned by apps/mcp. Trigger /api/admin/refresh on the MCP app from a trusted server context.',
    },
    { status: 410 }
  );
}
