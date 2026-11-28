/**
 * Where WorkOS AuthKit returns after a person signs in (lib/people.ts). It checks the state against
 * the signed cookie the authorization endpoint set, exchanges AuthKit's code for the person, lets in
 * only a verified email on ALLOWED_EMAILS, keeps them signed in for PERSON_SESSION_SECONDS, and goes
 * back to the authorization endpoint with the client's original request.
 *
 * Register this address in WorkOS as a redirect URI, and set it as WORKOS_REDIRECT_URI.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  PERSON_COOKIE,
  PERSON_SESSION_SECONDS,
  SIGNIN_STATE_COOKIE,
  clearCookie,
  cookieFrom,
  exchangeCode,
  isAllowed,
  readSignInState,
  setCookie,
  signInMissing,
  signPersonSession,
  workosSettings,
} from '../../../../../lib/people';
import { checkRateLimit } from '../../../../../lib/rateLimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CALLBACK_RATE_LIMIT = { limit: 30, windowMs: 15 * 60_000 };

function page(title: string, message: string, status: number): NextResponse {
  const res = new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>` +
      `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
      `<h1>${title}</h1><p>${message}</p></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
  );
  res.headers.append('Set-Cookie', clearCookie(SIGNIN_STATE_COOKIE));
  return res;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  if (!(await checkRateLimit(`oauth:workos-callback:${ip}`, CALLBACK_RATE_LIMIT))) {
    return page('Too many sign-ins', 'Too many sign-in attempts from here. Try again in a few minutes.', 429);
  }

  const settings = workosSettings();
  const missing = signInMissing();
  if (!settings || missing.length > 0) {
    console.error('[oauth/workos] sign-in is not set up; missing:', missing.join(', '));
    return page('Sign-in is not set up', 'Sign-in is not set up on this server yet, so no client can connect.', 503);
  }

  const params = req.nextUrl.searchParams;
  const returnTo = await readSignInState(cookieFrom(req.headers.get('cookie'), SIGNIN_STATE_COOKIE), params.get('state'));
  if (!returnTo) {
    return page('Sign-in expired', 'This sign-in has expired or did not start here. Go back to your app and connect again.', 400);
  }
  if (params.get('error')) {
    return page('Sign-in was not completed', 'WorkOS did not complete the sign-in. Go back to your app and connect again.', 400);
  }
  const code = params.get('code');
  if (!code) return page('Sign-in failed', 'WorkOS returned no code. Go back to your app and connect again.', 400);

  let person: { email: string; emailVerified: boolean };
  try {
    person = await exchangeCode(settings, code);
  } catch (err) {
    console.error('[oauth/workos] exchange failed:', err instanceof Error ? err.message : 'unknown');
    return page('Sign-in failed', 'The sign-in could not be checked with WorkOS. Try again in a moment.', 502);
  }
  if (!person.emailVerified) {
    return page('Email not verified', 'WorkOS has not verified this email address, so it cannot be let in.', 403);
  }
  if (!isAllowed(person.email)) {
    return page('Not on the list', 'This registry is open only to the people its owner has listed, and this address is not one of them.', 403);
  }

  const res = NextResponse.redirect(new URL(returnTo, req.nextUrl.origin), 302);
  res.headers.append('Set-Cookie', clearCookie(SIGNIN_STATE_COOKIE));
  res.headers.append('Set-Cookie', setCookie(PERSON_COOKIE, await signPersonSession(person.email), PERSON_SESSION_SECONDS));
  res.headers.set('Cache-Control', 'no-store');
  return res;
}
