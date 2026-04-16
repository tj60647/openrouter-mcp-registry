import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken, SESSION_COOKIE } from './lib/session';

export const config = {
  matcher: ['/admin/:path*'],
};

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;

  // The login page itself must remain accessible without a session
  if (pathname === '/admin/login') {
    return NextResponse.next();
  }

  const sessionSecret = process.env['ADMIN_SESSION_SECRET'];
  const token = req.cookies.get(SESSION_COOKIE)?.value;

  if (
    !sessionSecret ||
    !token ||
    !(await verifySessionToken(token, sessionSecret))
  ) {
    const loginUrl = new URL('/admin/login', req.url);
    loginUrl.searchParams.set('next', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}
