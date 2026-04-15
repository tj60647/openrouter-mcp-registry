import { z } from 'zod';

export const ModelIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9/_:.-]+$/, 'Invalid model ID format');

export const AliasSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/, 'Invalid alias format');

export const ResolveInputSchema = z.object({
  input: z.string().min(1).max(256),
});

export const RefreshRequestSchema = z.object({
  force: z.boolean().optional().default(false),
});

export const PaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
  provider: z.string().optional(),
});
