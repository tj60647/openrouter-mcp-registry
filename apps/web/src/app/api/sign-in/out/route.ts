/** Sign out of the chat demo: forget the visitor's tokens. POST only, so a link cannot do it. */
import { NextResponse } from 'next/server';
import { clearChatCookie } from '../../../../lib/chatSignIn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(): Promise<NextResponse> {
  const res = NextResponse.json({ signedIn: false });
  res.headers.append('Set-Cookie', clearChatCookie());
  res.headers.set('Cache-Control', 'no-store');
  return res;
}
