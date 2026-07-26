import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@openrouter-mcp/shared'],

  /**
   * apps/web is the docs/UI host. Every MCP API surface — `/api/mcp`,
   * `/api/oauth/*` and the `/.well-known/*` OAuth metadata — is served by
   * apps/mcp on a different origin, so a client handed the docs URL 404s on
   * those paths. When NEXT_PUBLIC_MCP_URL is set, forward them to the API host.
   *
   * `permanent: true` emits a **308 Permanent Redirect**, not a 301. That is
   * deliberate: 308 (like 307) is defined to preserve the request method and
   * body, so an MCP JSON-RPC `POST /api/mcp` or a form-encoded
   * `POST /api/oauth/token` survives the hop intact. Under a 301/302 a client is
   * allowed to rewrite the request as a bodyless GET and the call would fail on
   * arrival.
   *
   * Only paths apps/web does NOT serve are listed. apps/web owns `/api/admin/*`,
   * `/api/chat`, `/api/cron/sync`, `/api/health`, `/api/models`,
   * `/api/providers` and `/api/resolve` — none of them are redirected — and it
   * has no `/.well-known` routes at all, so the catch-all shadows nothing.
   */
  async redirects() {
    const mcpUrl = process.env['NEXT_PUBLIC_MCP_URL']?.replace(/\/+$/, '');

    // Unset or empty means single-host / local dev: emit no redirects at all.
    if (!mcpUrl) {
      return [];
    }

    return [
      { source: '/api/mcp', destination: `${mcpUrl}/api/mcp`, permanent: true },
      { source: '/api/mcp/:path*', destination: `${mcpUrl}/api/mcp/:path*`, permanent: true },
      { source: '/api/oauth/:path*', destination: `${mcpUrl}/api/oauth/:path*`, permanent: true },
      {
        source: '/.well-known/oauth-authorization-server',
        destination: `${mcpUrl}/.well-known/oauth-authorization-server`,
        permanent: true,
      },
      {
        source: '/.well-known/oauth-protected-resource',
        destination: `${mcpUrl}/.well-known/oauth-protected-resource`,
        permanent: true,
      },
      // Catch-all last: covers the path-suffixed metadata forms MCP clients
      // probe, e.g. /.well-known/oauth-authorization-server/api/mcp.
      {
        source: '/.well-known/:path*',
        destination: `${mcpUrl}/.well-known/:path*`,
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
