import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@openrouter-mcp/shared'],
  serverExternalPackages: ['@modelcontextprotocol/sdk'],

  /**
   * apps/mcp is the API host and serves no human-facing docs, so anyone who
   * appends `/mcp-info` to the MCP base URL gets a 404. When NEXT_PUBLIC_WEB_URL
   * is set, send them to the docs host, which owns that page.
   *
   * `permanent: true` emits a 308 rather than a 301 so the method and body are
   * preserved across the hop — irrelevant for this GET-only page, but it keeps
   * the behaviour identical to the API-side redirects in apps/web/next.config.ts.
   */
  async redirects() {
    const webUrl = process.env['NEXT_PUBLIC_WEB_URL']?.replace(/\/+$/, '');

    // Unset or empty means single-host / local dev: emit no redirects at all.
    if (!webUrl) {
      return [];
    }

    return [{ source: '/mcp-info', destination: `${webUrl}/mcp-info`, permanent: true }];
  },
};

export default nextConfig;
