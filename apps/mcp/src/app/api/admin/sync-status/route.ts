import { NextRequest, NextResponse } from 'next/server';
import { getSyncStatus } from '../../../../lib/db';
import { validateAdminToken } from '../../../../lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authError = validateAdminToken(req);
  if (authError) return authError;

  try {
    const status = await getSyncStatus();
    return NextResponse.json({ status });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
