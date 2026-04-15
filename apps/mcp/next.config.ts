import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@openrouter-mcp/shared'],
  serverExternalPackages: ['@modelcontextprotocol/sdk'],
};

export default nextConfig;
