/**
 * OAuth 2.1 Authorization Endpoint (RFC 6749 §3.1, RFC 7636 PKCE).
 *
 * A person must sign in (TJ, 2026-11-27: "The demo should require workos … Perhaps the mcp as
 * well"). The endpoint validates the client, the exact redirect URI and the PKCE challenge; then,
 * unless a valid sign-in cookie names someone on ALLOWED_EMAILS, it sends the browser to WorkOS
 * AuthKit, whose callback (../workos/callback) returns here with the same query. Then it issues a
 * single-use authorization code that carries the person (lib/people.ts) and redirects back. No
 * consent screen: being on the list is the consent.
 *
 * Sign-in not set up (lib/people.ts, signInMissing): production refuses every client (503); local
 * development keeps the old auto-approval, and its tokens carry no person, which only a
 * non-production server accepts.
 *
 * Security:
 *   - redirect_uri must EXACTLY match one registered for the client (no open
 *     redirect). If it doesn't, we render an error instead of redirecting.
 *   - PKCE with S256 is mandatory; `plain` is rejected.
 */

import { NextRequest, NextResponse } from 'next/server';
import { filterScopes } from '../../../../lib/oauth';
import { findClient, createAuthorizationCode } from '../../../../lib/oauthStore';
import {
  PERSON_COOKIE,
  SIGNIN_STATE_COOKIE,
  SIGNIN_STATE_SECONDS,
  authorizeUrl,
  cookieFrom,
  newSignInState,
  readPersonSession,
  safeReturnTo,
  sealAuthorizationCode,
  setCookie,
  signInMissing,
  workosSettings,
} from '../../../../lib/people';
import { checkRateLimit } from '../../../../lib/rateLimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const AUTHORIZE_RATE_LIMIT = { limit: 30, windowMs: 15 * 60_000 };

function errorPage(message: string, status: number): NextResponse {
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><title>Authorization error</title></head>` +
      `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
      `<h1>Authorization error</h1><p>${message}</p></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

/** Redirect back to the client with error params (used once redirect_uri is trusted). */
function errorRedirect(
  redirectUri: string,
  error: string,
  state: string | null,
  description?: string,
): NextResponse {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  if (description) url.searchParams.set('error_description', description);
  if (state) url.searchParams.set('state', state);
  return NextResponse.redirect(url, 302);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  if (!(await checkRateLimit(`oauth:authorize:${ip}`, AUTHORIZE_RATE_LIMIT))) {
    return errorPage('Too many authorization requests. Try again later.', 429);
  }

  const params = req.nextUrl.searchParams;
  const clientId = params.get('client_id');
  const redirectUri = params.get('redirect_uri');
  const responseType = params.get('response_type');
  const codeChallenge = params.get('code_challenge');
  const codeChallengeMethod = params.get('code_challenge_method') ?? 'plain';
  const scope = params.get('scope') ?? undefined;
  const state = params.get('state');

  // ── Validate client and redirect_uri BEFORE any redirect (open-redirect guard) ──
  if (!clientId) return errorPage('Missing client_id.', 400);
  if (!redirectUri) return errorPage('Missing redirect_uri.', 400);

  const client = await findClient(clientId);
  if (!client) return errorPage('Unknown client_id.', 400);
  if (!client.redirectUris.includes(redirectUri)) {
    return errorPage('redirect_uri does not match a registered URI for this client.', 400);
  }

  // From here on redirect_uri is trusted, so protocol errors go back to the client.
  if (responseType !== 'code') {
    return errorRedirect(redirectUri, 'unsupported_response_type', state);
  }
  if (!codeChallenge) {
    return errorRedirect(redirectUri, 'invalid_request', state, 'code_challenge is required (PKCE)');
  }
  if (codeChallengeMethod !== 'S256') {
    return errorRedirect(redirectUri, 'invalid_request', state, 'code_challenge_method must be S256');
  }

  const grantedScope = filterScopes(scope);

  // ── The person ──
  const missing = signInMissing();
  let sealed: string | undefined;
  if (missing.length > 0) {
    if (process.env['NODE_ENV'] === 'production') {
      console.error('[oauth/authorize] sign-in is not set up; missing:', missing.join(', '));
      return errorPage('Sign-in is not set up on this server yet, so no client can connect.', 503);
    }
  } else {
    const person = await readPersonSession(cookieFrom(req.headers.get('cookie'), PERSON_COOKIE));
    if (!person) {
      const returnTo = safeReturnTo(`${req.nextUrl.pathname}${req.nextUrl.search}`);
      const settings = workosSettings();
      if (!returnTo || !settings) return errorPage('This sign-in request is too long or malformed.', 400);
      const { nonce, cookie } = await newSignInState(returnTo);
      const res = NextResponse.redirect(authorizeUrl(settings, nonce), 302);
      res.headers.append('Set-Cookie', setCookie(SIGNIN_STATE_COOKIE, cookie, SIGNIN_STATE_SECONDS));
      return res;
    }
    sealed = await sealAuthorizationCode(person);
  }

  const code = await createAuthorizationCode({
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    scope: grantedScope,
    code: sealed,
  });

  const url = new URL(redirectUri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  return NextResponse.redirect(url, 302);
}
