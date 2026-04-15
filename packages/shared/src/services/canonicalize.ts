/**
 * Canonicalize a model ID.
 * OpenRouter model IDs are in the format "provider/model-name".
 * We treat them as opaque strings but normalize whitespace and case-fold the provider prefix.
 */
export function canonicalizeModelId(input: string): string {
  return input.trim();
}

/**
 * Extract the provider portion from a canonical model ID.
 * e.g. "anthropic/claude-3-sonnet-20240229" → "anthropic"
 */
export function extractProvider(modelId: string): string {
  const slash = modelId.indexOf('/');
  if (slash === -1) return 'unknown';
  return modelId.substring(0, slash);
}

/**
 * Check whether a string looks like a canonical model ID (contains a slash).
 */
export function isCanonicalId(input: string): boolean {
  return input.includes('/');
}
