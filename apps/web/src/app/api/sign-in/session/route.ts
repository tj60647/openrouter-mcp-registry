/** Whether the visitor is signed in to the chat demo, and as whom (lib/chatSignIn.ts). */
import { NextRequest, NextResponse } from 'next/server';
import { CHAT_COOKIE, chatSignInSettings, cookieFrom, currentAccessToken, isConfigured, personOf } from '../../../../lib/chatSignIn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const settings = chatSignInSettings();
  if (!isConfigured(settings)) return NextResponse.json({ configured: false, signedIn: false, person: null }, { headers: { 'Cache-Control': 'no-store' } });
  const current = await currentAccessToken(settings, cookieFrom(req.headers.get('cookie'), CHAT_COOKIE));
  const res = NextResponse.json(
    { configured: true, signedIn: Boolean(current), person: current ? personOf(current.access) : null },
    { headers: { 'Cache-Control': 'no-store' } },
  );
  if (current?.setCookie) res.headers.append('Set-Cookie', current.setCookie);
  return res;
}
