/**
 * @file mcp-info-docs.test.ts
 * Guards the /mcp-info integration reference against the real tool schemas.
 *
 * That page is a hand-maintained mirror of the zod schemas in mcp-server.ts,
 * and it is the document integrators read to construct calls. Nothing kept the
 * two in step: when `fields` became an enum and `get_sync_history` grew a
 * lifecycle, the page said the old thing until someone noticed by hand.
 *
 * These tests read the page's own TOOLS table and compare it against the
 * schemas captured from a real registration, so a bound or default that moves
 * in code without moving in the docs fails the build.
 *
 * It reaches across workspaces to read apps/web by path. That is deliberate:
 * the alternative is a shared metadata module, which is a much larger change
 * than the drift warrants, and a stale docs page is worth catching cheaply.
 *
 * Author: Thomas J McLeish
 * License: MIT
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import type { ZodTypeAny } from 'zod';

const MCP_INFO = join('..', 'web', 'src', 'app', 'mcp-info', 'page.tsx');

// ── The documented side ───────────────────────────────────────────────────────

interface DocumentedTool {
  name: string;
  params: string;
}

/**
 * Pull the `name` / `params` pairs out of the page's TOOLS array.
 *
 * Scoped to that array specifically: the page also documents prompts, which
 * carry the same `name`/`params` shape but are registered through
 * `server.prompt` and so are not tools.
 */
function readDocumentedTools(): DocumentedTool[] {
  const source = readFileSync(MCP_INFO, 'utf8');
  const start = source.indexOf('const TOOLS = [');
  expect(start, `TOOLS array not found in ${MCP_INFO} — has the page been restructured?`).toBeGreaterThan(-1);
  const end = source.indexOf('] as const;', start);
  expect(end, 'TOOLS array is not terminated by "] as const;"').toBeGreaterThan(start);
  const block = source.slice(start, end);

  const tools: DocumentedTool[] = [];
  const entry = /name:\s*'([a-z_]+)',[\s\S]*?params:\s*'([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = entry.exec(block)) !== null) tools.push({ name: m[1]!, params: m[2]! });
  return tools;
}

/**
 * Slice a params string into one chunk per field, keyed by field name.
 *
 * Split on where each field *starts* rather than on commas: a field's text can
 * contain commas inside parentheses ("(omit = all records)") and alternations
 * inside quotes ('"asc" | "desc"').
 */
function sliceParams(params: string): Map<string, string> {
  const starts: Array<{ name: string; at: number }> = [];
  const field = /(\w+)\??:/g;
  let m: RegExpExecArray | null;
  while ((m = field.exec(params)) !== null) starts.push({ name: m[1]!, at: m.index });

  const slices = new Map<string, string>();
  starts.forEach((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1]!.at : params.length;
    slices.set(s.name, params.slice(s.at, end));
  });
  return slices;
}

// ── The real side ─────────────────────────────────────────────────────────────

const schemas: Record<string, Record<string, ZodTypeAny>> = {};

beforeAll(async () => {
  const registered: Record<string, Record<string, ZodTypeAny>> = {};
  const fake = {
    tool: (...args: unknown[]) => {
      if (args.length > 3 && args[2] && typeof args[2] === 'object') {
        registered[args[0] as string] = args[2] as Record<string, ZodTypeAny>;
      }
    },
    resource: () => {},
    prompt: () => {},
    connect: async () => {},
  };
  const { initMcpServer } = await import('../lib/mcp-server');
  await initMcpServer(fake as never);
  Object.assign(schemas, registered);
});

/** The default a field applies, or undefined when it has none. */
function defaultOf(schema: ZodTypeAny): unknown {
  let cur: unknown = schema;
  for (let i = 0; i < 12; i += 1) {
    const def = (cur as { _def?: { typeName?: string; innerType?: unknown; defaultValue?: () => unknown } })._def;
    if (def?.typeName === 'ZodDefault') return def.defaultValue?.();
    if (def?.typeName === 'ZodOptional') { cur = def.innerType; continue; }
    return undefined;
  }
  return undefined;
}

function isOptional(schema: ZodTypeAny): boolean {
  return schema.isOptional();
}

/** How a default is written in the docs: numbers bare, strings quoted. */
function documentedForm(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : String(value);
}

/**
 * The default a docs slice claims, or undefined when it claims none.
 *
 * Only a literal counts. Prose like "(omit = all records)" is an explanation of
 * what happens without the parameter, not a claimed default, and must not be
 * mistaken for one.
 */
function documentedDefault(slice: string): string | undefined {
  const m = /=\s*(-?\d+(?:\.\d+)?|"[^"]*"|true|false)/.exec(slice);
  return m?.[1];
}

function accepts(schema: ZodTypeAny, value: unknown): boolean {
  return z.object({ v: schema }).safeParse({ v: value }).success;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('/mcp-info tool reference', () => {
  it('documents every registered tool', () => {
    const documented = readDocumentedTools().map((t) => t.name).sort();
    expect(documented).toEqual(Object.keys(schemas).sort());
  });

  it('documents every parameter of every tool', () => {
    const missing: string[] = [];
    for (const { name, params } of readDocumentedTools()) {
      const slices = sliceParams(params);
      for (const field of Object.keys(schemas[name] ?? {})) {
        if (!slices.has(field)) missing.push(`${name}.${field}`);
      }
    }
    expect(missing, `undocumented parameters: ${missing.join(', ')}`).toEqual([]);
  });

  it('does not document parameters that no longer exist', () => {
    const phantom: string[] = [];
    for (const { name, params } of readDocumentedTools()) {
      const real = schemas[name] ?? {};
      for (const field of sliceParams(params).keys()) {
        if (!(field in real)) phantom.push(`${name}.${field}`);
      }
    }
    expect(phantom, `documented but not registered: ${phantom.join(', ')}`).toEqual([]);
  });

  // The one that matters: this is the class of drift that had `list_models`
  // read as though it defaulted to a page size when it defaults to no limit
  // at all. Checked in BOTH directions — a default the docs invent is as
  // misleading as one they omit.
  it('states the same default the schema applies, and only where there is one', () => {
    const wrong: string[] = [];
    for (const { name, params } of readDocumentedTools()) {
      const slices = sliceParams(params);
      for (const [field, schema] of Object.entries(schemas[name] ?? {})) {
        const slice = slices.get(field) ?? '';
        const applied = defaultOf(schema);
        const claimed = documentedDefault(slice);

        if (applied === undefined && claimed !== undefined) {
          wrong.push(
            `${name}.${field}: docs claim a default of ${claimed}, schema applies none ` +
              `(omitting the parameter does not substitute a value)`
          );
        } else if (applied !== undefined && claimed === undefined) {
          wrong.push(`${name}.${field}: schema applies ${documentedForm(applied)}, docs state no default`);
        } else if (applied !== undefined && claimed !== documentedForm(applied)) {
          wrong.push(`${name}.${field}: schema applies ${documentedForm(applied)}, docs claim ${claimed}`);
        }
      }
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  it('marks a parameter optional if and only if the schema does', () => {
    const wrong: string[] = [];
    for (const { name, params } of readDocumentedTools()) {
      const slices = sliceParams(params);
      for (const [field, schema] of Object.entries(schemas[name] ?? {})) {
        const slice = slices.get(field) ?? '';
        const documentedOptional = slice.startsWith(`${field}?:`);
        if (documentedOptional !== isOptional(schema)) {
          wrong.push(
            `${name}.${field}: schema optional=${isOptional(schema)}, docs optional=${documentedOptional}`
          );
        }
      }
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  it('states the same numeric range the schema enforces', () => {
    const wrong: string[] = [];
    for (const { name, params } of readDocumentedTools()) {
      const slices = sliceParams(params);
      for (const [field, schema] of Object.entries(schemas[name] ?? {})) {
        const slice = slices.get(field) ?? '';
        // Only check fields whose docs actually claim a range, written as
        // "(1-100)" with an en dash. A field with no stated range is an
        // omission, not a contradiction, and is left to the prose below it.
        const stated = /\((\d+)[–-](\d+)\)/.exec(slice);
        if (!stated) continue;
        const min = Number(stated[1]);
        const max = Number(stated[2]);

        // Both directions. Checking only that max+1 is rejected would pass a
        // docs range far WIDER than the schema's, which reads as permission to
        // send a value the server will refuse.
        if (!accepts(schema, min)) wrong.push(`${name}.${field}: docs claim min ${min}, schema rejects it`);
        if (accepts(schema, min - 1)) wrong.push(`${name}.${field}: docs claim min ${min}, schema accepts ${min - 1}`);
        if (!accepts(schema, max)) wrong.push(`${name}.${field}: docs claim max ${max}, schema rejects it`);
        if (accepts(schema, max + 1)) wrong.push(`${name}.${field}: docs claim max ${max}, schema accepts ${max + 1}`);
      }
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });
});
