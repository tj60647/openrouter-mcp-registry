/**
 * Who is calling, from a bearer token: the MCP endpoint and the chat route both ask here, so the
 * rule is written once.
 *
 *   - a token with a `person` (an interactive client a person signed in to, lib/people.ts) is
 *     accepted only while that person is on ALLOWED_EMAILS;
 *   - a token with `grant: client_credentials` is a service client, a machine;
 *   - a token with neither was issued before sign-in was required. Production refuses it (an
 *     access token lives an hour, so this ends within the hour of deploying); local development,
 *     where sign-in may not be set up, accepts it.
 */

import { verifyAccessToken } from './oauth';
import { isAllowed } from './people';

export interface Caller {
  clientId: string;
  scopes: string[];
  /** The signed-in person's email, or null for a service client (or local development). */
  person: string | null;
  service: boolean;
}

/** The caller a token speaks for, or null when it may not call at all. */
export async function callerFromToken(token: string | undefined): Promise<Caller | null> {
  if (!token) return null;
  let claims;
  try {
    claims = await verifyAccessToken(token);
  } catch {
    return null;
  }
  const person = typeof claims.person === 'string' ? claims.person : null;
  const service = claims.grant === 'client_credentials';
  if (person && !isAllowed(person)) return null;
  if (!person && !service && process.env['NODE_ENV'] === 'production') return null;
  return {
    clientId: claims.sub ?? 'unknown',
    scopes: (claims.scope ?? 'mcp:read').split(' ').filter(Boolean),
    person,
    service,
  };
}
