/**
 * GitHub sign-in for the admin area.
 *
 * This lives in apps/web because it mints the same web-owned admin session
 * cookie the password form does (see lib/session.ts). It needs no database, so
 * it does not disturb the MCP-owned backend boundary: authorisation is an
 * explicit allowlist of GitHub logins in the environment, not a lookup.
 *
 * Configuration — all three are required, and sign-in stays off unless all
 * three are present:
 *   GITHUB_CLIENT_ID       OAuth app client id
 *   GITHUB_CLIENT_SECRET   OAuth app client secret (server-side only)
 *   GITHUB_ADMIN_LOGINS    comma-separated GitHub logins allowed to administer
 *
 * The OAuth app's callback URL must be <web-origin>/api/admin/oauth/github/callback.
 */

/** Cookie holding the one-time CSRF state for an in-flight sign-in. */
export const OAUTH_STATE_COOKIE = 'admin_github_state';
/** A sign-in that takes longer than this is abandoned rather than resumed. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const GITHUB_USER_URL = 'https://api.github.com/user';

export interface GithubOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Lower-cased allowlist. Never empty — an empty allowlist disables sign-in. */
  admins: string[];
}

/**
 * Read the configuration, or null when sign-in is not fully configured.
 *
 * Fails closed on every partial configuration, including an allowlist that is
 * present but empty. An empty allowlist must never be read as "anyone with a
 * GitHub account", which is what a naive `.includes` on an empty array would
 * quietly avoid but a `length === 0 -> allow all` shortcut would not.
 */
export function getGithubOAuthConfig(): GithubOAuthConfig | null {
  const clientId = process.env['GITHUB_CLIENT_ID']?.trim();
  const clientSecret = process.env['GITHUB_CLIENT_SECRET']?.trim();
  const admins = (process.env['GITHUB_ADMIN_LOGINS'] ?? '')
    .split(',')
    .map((login) => login.trim().toLowerCase())
    .filter(Boolean);

  if (!clientId || !clientSecret || admins.length === 0) return null;
  return { clientId, clientSecret, admins };
}

/** Whether the admin login page should offer the GitHub button. */
export function isGithubOAuthEnabled(): boolean {
  return getGithubOAuthConfig() !== null;
}

/**
 * GitHub logins are case-insensitive, so the comparison is too. The allowlist
 * is already lower-cased by `getGithubOAuthConfig`.
 */
export function isAllowedAdmin(login: string, config: GithubOAuthConfig): boolean {
  return config.admins.includes(login.trim().toLowerCase());
}

/** Cryptographically random state value, bound to the sign-in via a cookie. */
export function generateState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Length-independent comparison, so a mismatch leaks nothing through timing. */
export function statesMatch(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Where to send the browser after a successful sign-in.
 *
 * The middleware puts the originally-requested path in `?next=`, and that value
 * reaches us through a redirect the user does not control end-to-end — so it is
 * treated as hostile. Only a path inside /admin is accepted. Anything else,
 * including a protocol-relative `//evil.example` or a path that merely starts
 * with the right letters like `/administrator-evil`, falls back to /admin.
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next) return '/admin';
  if (!next.startsWith('/')) return '/admin';
  // `//host` and `/\host` are protocol-relative URLs, not local paths.
  if (next.startsWith('//') || next.startsWith('/\\')) return '/admin';
  if (next !== '/admin' && !next.startsWith('/admin/')) return '/admin';
  return next;
}

export function buildAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set('client_id', opts.clientId);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('state', opts.state);
  // read:user is enough to read the login. Deliberately NOT requesting
  // read:org, repo, or anything that would let this app act on the account:
  // all it needs to decide is "which GitHub user is this".
  url.searchParams.set('scope', 'read:user');
  url.searchParams.set('allow_signup', 'false');
  return url.toString();
}

/** Exchange the authorization code for an access token. Never log the result. */
export async function exchangeCodeForToken(opts: {
  code: string;
  redirectUri: string;
  config: GithubOAuthConfig;
}): Promise<string | null> {
  const res = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: opts.config.clientId,
      client_secret: opts.config.clientSecret,
      code: opts.code,
      redirect_uri: opts.redirectUri,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as
    | { access_token?: string; error?: string }
    | null;
  // GitHub reports failures as HTTP 200 with an `error` member, so a bare
  // res.ok check is not enough to conclude the exchange worked.
  if (!data || data.error || !data.access_token) return null;
  return data.access_token;
}

/** Fetch the authenticated user's login, or null if the token is not usable. */
export async function fetchGithubLogin(accessToken: string): Promise<string | null> {
  const res = await fetch(GITHUB_USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'openrouter-registry-mcp',
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as { login?: unknown } | null;
  return typeof data?.login === 'string' && data.login ? data.login : null;
}

/** The callback URL, derived from the incoming request's own origin. */
export function callbackUrlFor(requestUrl: string): string {
  return new URL('/api/admin/oauth/github/callback', requestUrl).toString();
}
