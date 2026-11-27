import { NextRequest, NextResponse } from 'next/server';
import {
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_TTL_MS,
  buildAuthorizeUrl,
  callbackUrlFor,
  generateState,
  getGithubOAuthConfig,
  safeNextPath,
} from '../../../../../../lib/githubOAuth';
import { checkRateLimit } from '../../../../../../lib/rateLimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Starting a sign-in is cheap but not free — it is the only unauthenticated
// endpoint here, and each hit sends a browser to GitHub.
const START_RATE_LIMIT = { limit: 20, windowMs: 15 * 60_000 };

/**
 * Begin GitHub sign-in: mint a one-time state, remember it in a cookie, and
 * hand the browser to GitHub.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  if (!checkRateLimit(`admin:github:start:${ip}`, START_RATE_LIMIT)) {
    return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429 });
  }

  const config = getGithubOAuthConfig();
  if (!config) {
    // Not configured is not an error the visitor can act on, and saying which
    // piece is missing would describe the deployment to anyone who asks.
    return NextResponse.json({ error: 'GitHub sign-in is not enabled' }, { status: 404 });
  }

  const state = generateState();
  const next = safeNextPath(req.nextUrl.searchParams.get('next'));

  const res = NextResponse.redirect(
    buildAuthorizeUrl({
      clientId: config.clientId,
      redirectUri: callbackUrlFor(req.url),
      state,
    })
  );

  // sameSite 'lax', NOT 'strict'. GitHub sends the browser back with a
  // cross-site top-level navigation, and a strict cookie is withheld on that
  // request — the callback would find no state and reject every sign-in. Lax
  // still withholds the cookie from cross-site POSTs, which is what CSRF
  // protection needs here.
  res.cookies.set(OAUTH_STATE_COOKIE, `${state}:${next}`, {
    httpOnly: true,
    secure: process.env['NODE_ENV'] === 'production',
    sameSite: 'lax',
    path: '/api/admin/oauth/github',
    maxAge: OAUTH_STATE_TTL_MS / 1000,
  });

  return res;
}
