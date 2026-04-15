import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@openrouter-mcp/shared'],
  experimental: {
    serverComponentsExternalPackages: ['@modelcontextprotocol/sdk'],
  },
};

export default nextConfig;
