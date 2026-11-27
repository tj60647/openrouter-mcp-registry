/** Start signing in to the chat demo through apps/mcp (lib/chatSignIn.ts). */
import { NextRequest, NextResponse } from 'next/server';
import { chatSignInSettings, isConfigured, startSignIn } from '../../../../lib/chatSignIn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const settings = chatSignInSettings();
  if (!isConfigured(settings)) {
    console.error('[sign-in] not set up; missing:', settings.missing.join(', '));
    return new NextResponse('Sign-in for the chat is not set up yet.', { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  const { location, cookie } = startSignIn(settings, req.nextUrl.origin, req.nextUrl.searchParams.get('return') ?? '/demo');
  const res = NextResponse.redirect(location, 302);
  res.headers.append('Set-Cookie', cookie);
  res.headers.set('Cache-Control', 'no-store');
  return res;
}
