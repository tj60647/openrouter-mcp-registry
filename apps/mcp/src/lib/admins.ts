import { sql } from '@vercel/postgres';
import { normalizeAdminUsername } from './adminAuth';

export interface AdminUser {
  id: number;
  username: string;
  passwordHash: string;
  active: boolean;
}

export async function getActiveAdminByUsername(username: string): Promise<AdminUser | null> {
  const normalizedUsername = normalizeAdminUsername(username);
  if (!normalizedUsername) return null;

  const result = await sql`
    SELECT id, username, password_hash, active
    FROM admins
    WHERE username = ${normalizedUsername} AND active = TRUE
    LIMIT 1
  `;

  const row = result.rows[0] as
    | { id: number; username: string; password_hash: string; active: boolean }
    | undefined;
  if (!row) return null;

  return { id: row.id, username: row.username, passwordHash: row.password_hash, active: row.active };
}
