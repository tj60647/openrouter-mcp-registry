import { NextRequest, NextResponse } from 'next/server';
import { validateAdminToken } from '../../../../lib/auth';
import { listClients } from '../../../../lib/oauthStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** List all registered OAuth clients (for the admin panel). Server-to-server; requires ADMIN_SECRET. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const authError = validateAdminToken(req);
  if (authError) return authError;

  try {
    const clients = await listClients();
    return NextResponse.json({ clients });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
