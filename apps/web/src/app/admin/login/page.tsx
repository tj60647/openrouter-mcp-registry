import { Suspense } from 'react';
import LoginForm from './LoginForm';
import { isGithubOAuthEnabled } from '../../../lib/githubOAuth';

/**
 * Server component wrapper so the page can decide whether to offer GitHub
 * sign-in without exposing anything to the browser.
 *
 * Whether sign-in is configured is derived on the server from GITHUB_CLIENT_ID,
 * GITHUB_CLIENT_SECRET and GITHUB_ADMIN_LOGINS. Only the resulting boolean
 * crosses to the client — deliberately not a NEXT_PUBLIC_* mirror of any of
 * them, which would ship configuration to every visitor and is the pattern
 * env-boundary.test.ts exists to prevent.
 */
export const dynamic = 'force-dynamic';

export default function AdminLoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm githubEnabled={isGithubOAuthEnabled()} />
    </Suspense>
  );
}
