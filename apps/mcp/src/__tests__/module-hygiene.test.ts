/**
 * @file module-hygiene.test.ts
 * Guards against the failure mode that let apps/mcp/src/lib/mcpServer.ts sit
 * unreferenced next to the live mcp-server.ts for two months: two modules whose
 * paths differ only by case or by punctuation are one typo away from resolving
 * to each other, and on a case-insensitive filesystem (macOS, Windows) they can
 * collide outright.
 *
 * Author: Thomas J McLeish
 * License: MIT
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

/** Lowercased, with `-` and `_` stripped: "mcp-server.ts" and "mcpServer.ts" collapse to one key. */
function collisionKey(path: string): string {
  return relative('src', path).replace(/\\/g, '/').toLowerCase().replace(/[-_]/g, '');
}

describe('module hygiene', () => {
  it('has no two modules whose paths differ only by case or punctuation', () => {
    const byKey = new Map<string, string[]>();
    for (const file of sourceFiles('src')) {
      const key = collisionKey(file);
      byKey.set(key, [...(byKey.get(key) ?? []), file.replace(/\\/g, '/')]);
    }

    const collisions = [...byKey.values()].filter((paths) => paths.length > 1);
    expect(collisions, `near-identical module paths: ${JSON.stringify(collisions)}`).toEqual([]);
  });
});
