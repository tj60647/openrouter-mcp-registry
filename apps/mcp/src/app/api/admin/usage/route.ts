import { NextRequest, NextResponse } from 'next/server';
import { validateAdminToken } from '../../../../lib/auth';
import { getUsageReport } from '../../../../lib/oauthStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** MCP usage aggregated by client and tool. Server-to-server; requires ADMIN_SECRET. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const authError = validateAdminToken(req);
  if (authError) return authError;

  try {
    const daysParam = Number(req.nextUrl.searchParams.get('days'));
    const windowDays = Number.isFinite(daysParam) && daysParam > 0 && daysParam <= 365 ? daysParam : 30;
    const report = await getUsageReport(windowDays);
    return NextResponse.json(report);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
