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
    // 503, not 200. Reaching here means the database is unreachable, and most
    // monitors key on the HTTP status alone — a 200 with a "degraded" body
    // reports the service healthy while it cannot serve a single query.
    return NextResponse.json(
      { status: 'degraded', error: message, timestamp: new Date().toISOString() },
      { status: 503 }
    );
  }
}
