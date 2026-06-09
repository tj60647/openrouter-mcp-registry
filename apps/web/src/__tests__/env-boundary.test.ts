import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../..');
const webRoot = path.join(repoRoot, 'apps/web');
const publicEnvFiles = [
  path.join(repoRoot, '.env.example'),
  path.join(webRoot, '.env.example'),
  path.join(repoRoot, 'apps/mcp/.env.example'),
];
const secretNames = [
  'OPENROUTER_API_KEY',
  'POSTGRES_URL',
  'DATABASE_URL',
  'MCP_CLIENT_SECRET',
  'OAUTH_JWT_SECRET',
  'ADMIN_SECRET',
  'ADMIN_SESSION_SECRET',
  'CRON_SECRET',
  'PGPASSWORD',
];

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(fullPath);
    return fullPath;
  });
}

describe('apps/web env boundary', () => {
  it('does not define NEXT_PUBLIC variables with secret-like names', () => {
    for (const file of publicEnvFiles) {
      const content = fs.readFileSync(file, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const key = line.split('=')[0]?.trim();
        if (!key?.startsWith('NEXT_PUBLIC_')) continue;
        expect(key).not.toMatch(/SECRET|TOKEN|KEY|PASSWORD|POSTGRES|DATABASE|NEON|PG/i);
      }
    }
  });

  it('does not reference server secret env vars from browser-executed web files', () => {
    const browserFiles = walk(path.join(webRoot, 'src'))
      .filter((file) => /\.(tsx|ts)$/.test(file))
      .filter((file) => fs.readFileSync(file, 'utf8').startsWith("'use client';"));

    for (const file of browserFiles) {
      const content = fs.readFileSync(file, 'utf8');
      for (const secret of secretNames) {
        expect(content, `${path.relative(repoRoot, file)} references ${secret}`).not.toContain(
          secret
        );
      }
      expect(content, `${path.relative(repoRoot, file)} references process.env`).not.toContain(
        'process.env'
      );
    }
  });
});
