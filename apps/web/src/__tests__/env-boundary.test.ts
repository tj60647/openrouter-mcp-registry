import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const SECRET_NAMES = [
  'OPENROUTER_API_KEY',
  'POSTGRES_URL',
  'DATABASE_URL',
  'MCP_CLIENT_SECRET',
  'OAUTH_JWT_SECRET',
  'ADMIN_SECRET',
  'CRON_SECRET',
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

describe('apps/web env/security boundary', () => {
  it('does not introduce NEXT_PUBLIC secret variables', () => {
    const files = ['.env.example', ...sourceFiles('src')];
    const combined = files.map((file) => readFileSync(file, 'utf8')).join('\n');

    for (const secretName of SECRET_NAMES) {
      expect(combined).not.toContain(`NEXT_PUBLIC_${secretName}`);
    }
  });

  it('does not reference server secret env vars from client components', () => {
    const clientFiles = sourceFiles('src').filter((file) => {
      const text = readFileSync(file, 'utf8');
      return text.startsWith("'use client'") || text.startsWith('"use client"');
    });

    for (const file of clientFiles) {
      const text = readFileSync(file, 'utf8');
      for (const secretName of SECRET_NAMES) {
        expect(text, `${file} must not reference ${secretName}`).not.toContain(secretName);
      }
    }
  });
});
