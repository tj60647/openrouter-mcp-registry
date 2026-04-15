import { describe, it, expect } from 'vitest';
import { canonicalizeModelId, extractProvider, isCanonicalId } from '../services/canonicalize';

describe('canonicalizeModelId', () => {
  it('trims whitespace', () => {
    expect(canonicalizeModelId('  anthropic/claude-3  ')).toBe('anthropic/claude-3');
  });

  it('leaves canonical IDs intact', () => {
    expect(canonicalizeModelId('openai/gpt-4o')).toBe('openai/gpt-4o');
  });
});

describe('extractProvider', () => {
  it('extracts provider from canonical id', () => {
    expect(extractProvider('anthropic/claude-3-sonnet')).toBe('anthropic');
  });

  it('returns unknown for non-canonical id', () => {
    expect(extractProvider('sonnet')).toBe('unknown');
  });
});

describe('isCanonicalId', () => {
  it('returns true when slash is present', () => {
    expect(isCanonicalId('anthropic/claude-3')).toBe(true);
  });

  it('returns false for alias', () => {
    expect(isCanonicalId('sonnet')).toBe(false);
  });
});
