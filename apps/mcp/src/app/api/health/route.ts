import { NextResponse } from 'next/server';
import { getSyncStatus } from '../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Liveness plus the current sync status.
 *
 * `syncStatus` carries the whole `SyncStatus` record, not a subset. It used to
 * return only lastSuccessfulSync and recordCount, which quietly broke the
 * /sync-status page: that page renders all four fields, so "Last Attempted
 * Sync" always read "Never" and "Last Error" always read "No errors", however
 * badly the last sync had gone.
 *
 * Nothing here is newly public. The `get_registry_status` MCP tool already
 * returns this same record, lastError included, to any client.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const syncStatus = await getSyncStatus();
    return NextResponse.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      syncStatus,
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
