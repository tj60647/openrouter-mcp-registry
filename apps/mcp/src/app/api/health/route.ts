import { NextResponse } from 'next/server';
import { getSyncStatus } from '../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    const syncStatus = await getSyncStatus();
    return NextResponse.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      syncStatus: syncStatus
        ? {
            lastSuccessfulSync: syncStatus.lastSuccessfulSync,
            recordCount: syncStatus.recordCount,
          }
        : null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ status: 'degraded', error: message }, { status: 200 });
  }
}
