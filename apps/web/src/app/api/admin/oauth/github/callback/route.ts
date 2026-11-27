import { NextRequest, NextResponse } from 'next/server';
import {
  OAUTH_STATE_COOKIE,
  callbackUrlFor,
  exchangeCodeForToken,
  fetchGithubLogin,
  getGithubOAuthConfig,
  isAllowedAdmin,
  safeNextPath,
  statesMatch,
} from '../../../../../../lib/githubOAuth';
import { createSessionToken, SESSION_COOKIE, SESSION_TTL_MS } from '../../../../../../lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Send the visitor back to the login page with a short reason.
 *
 * The reason is a fixed code, never upstream text: an attacker should not be
 * able to paint arbitrary content onto the login screen, and a failed sign-in
 * should not reveal whether a GitHub account exists or merely lacks access.
 */
function fail(req: NextRequest, reason: 'denied' | 'invalid' | 'unavailable'): NextResponse {
  const url = new URL('/admin/login', req.url);
  url.searchParams.set('error', reason);
  const res = NextResponse.redirect(url);
  res.cookies.delete(OAUTH_STATE_COOKIE);
  return res;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const config = getGithubOAuthConfig();
  if (!config) return fail(req, 'unavailable');

  // The state cookie carries both halves of the handshake: the value to compare
  // and the destination captured when the sign-in began. Reading `next` from
  // the cookie rather than the query string means the redirect target cannot be
  // swapped between start and callback.
  const cookie = req.cookies.get(OAUTH_STATE_COOKIE)?.value ?? '';
  const separator = cookie.indexOf(':');
  const expectedState = separator === -1 ? cookie : cookie.slice(0, separator);
  const next = safeNextPath(separator === -1 ? null : cookie.slice(separator + 1));

  const params = req.nextUrl.searchParams;

  // The user declined on GitHub's consent screen, or GitHub refused.
  if (params.get('error')) return fail(req, 'denied');

  const returnedState = params.get('state') ?? '';
  const code = params.get('code') ?? '';
  if (!code || !expectedState || !statesMatch(expectedState, returnedState)) {
    return fail(req, 'invalid');
  }

  const accessToken = await exchangeCodeForToken({
    code,
    redirectUri: callbackUrlFor(req.url),
    config,
  }).catch(() => null);
  if (!accessToken) return fail(req, 'invalid');

  const login = await fetchGithubLogin(accessToken).catch(() => null);
  if (!login) return fail(req, 'invalid');

  if (!isAllowedAdmin(login, config)) return fail(req, 'denied');

  const sessionSecret = process.env['ADMIN_SESSION_SECRET'];
  if (!sessionSecret) return fail(req, 'unavailable');

  const token = await createSessionToken(sessionSecret, login);
  const res = NextResponse.redirect(new URL(next, req.url));

  // 'lax' rather than the password path's 'strict' for the same reason the
  // state cookie uses it: this response is the tail of a redirect chain that
  // began cross-site at github.com, and a strict cookie can be withheld on the
  // hop that follows — landing the visitor back on the login page in a loop.
  // Lax still keeps the cookie off cross-site POSTs, which is where CSRF bites.
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env['NODE_ENV'] === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });

  // One-time state: consumed whether or not it worked, so a code cannot be
  // replayed against a still-valid cookie.
  res.cookies.delete(OAUTH_STATE_COOKIE);
  return res;
}
