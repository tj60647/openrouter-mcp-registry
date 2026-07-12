import { NextRequest, NextResponse } from 'next/server';
import { requireAdminSession } from '../../../../lib/requireAdminSession';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Returns the currently signed-in admin's identity (for the admin panel header). */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { session, error } = await requireAdminSession(req);
  if (error) return error;
  return NextResponse.json({ username: session.username });
}
