import { NextRequest, NextResponse } from 'next/server';
import { validateAdminToken } from '../../../../../lib/auth';
import { revokeClient, unrevokeClient } from '../../../../../lib/oauthStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Revoke (or restore) an OAuth client. A revoked client can no longer obtain
 * tokens. Server-to-server; requires ADMIN_SECRET.
 * Body: { client_id: string, action?: 'revoke' | 'unrevoke' }
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const authError = validateAdminToken(req);
  if (authError) return authError;

  try {
    const body = (await req.json().catch(() => ({}))) as { client_id?: unknown; action?: unknown };
    const clientId = typeof body.client_id === 'string' ? body.client_id : '';
    const action = body.action === 'unrevoke' ? 'unrevoke' : 'revoke';
    if (!clientId) {
      return NextResponse.json({ error: 'client_id is required' }, { status: 400 });
    }

    const changed =
      action === 'revoke' ? await revokeClient(clientId) : await unrevokeClient(clientId);
    return NextResponse.json({ ok: true, action, changed });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
