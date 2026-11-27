/**
 * Where apps/mcp returns after the visitor signs in: check the state, exchange the code (with the
 * PKCE verifier) for the visitor's own tokens, keep them in the encrypted cookie, and go back to
 * the page they started from (lib/chatSignIn.ts).
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  SIGNIN_COOKIE,
  chatSignInSettings,
  clearSignInCookie,
  cookieFrom,
  exchangeCode,
  isConfigured,
  readSignIn,
  sealTokens,
} from '../../../../lib/chatSignIn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function back(req: NextRequest, path: string, problem?: string): NextResponse {
  const url = new URL(path, req.nextUrl.origin);
  if (problem) url.searchParams.set('sign_in', problem);
  const res = NextResponse.redirect(url, 302);
  res.headers.append('Set-Cookie', clearSignInCookie());
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const settings = chatSignInSettings();
  if (!isConfigured(settings)) return back(req, '/demo', 'not_set_up');
  const params = req.nextUrl.searchParams;
  const attempt = readSignIn(settings, cookieFrom(req.headers.get('cookie'), SIGNIN_COOKIE), params.get('state'));
  if (!attempt) return back(req, '/demo', 'expired');
  if (params.get('error')) return back(req, attempt.ret, 'refused');
  const code = params.get('code');
  if (!code) return back(req, attempt.ret, 'refused');
  try {
    const tokens = await exchangeCode(settings, req.nextUrl.origin, code, attempt.verifier);
    const res = back(req, attempt.ret);
    res.headers.append('Set-Cookie', sealTokens(settings, tokens));
    return res;
  } catch (err) {
    console.error('[sign-in] code exchange failed:', err instanceof Error ? err.message : 'unknown');
    return back(req, attempt.ret, 'failed');
  }
}
