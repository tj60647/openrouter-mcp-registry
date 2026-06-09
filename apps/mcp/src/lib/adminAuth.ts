import { timingSafeEqual, scrypt as scryptCallback } from 'crypto';
import { promisify } from 'util';

const scrypt = promisify(scryptCallback);

export function normalizeAdminUsername(username: string): string {
  return username.trim().toLowerCase();
}

export async function verifyAdminPassword(password: string, storedHash: string): Promise<boolean> {
  const [salt, key] = storedHash.split(':');
  if (!salt || !key) return false;

  const keyBuffer = Buffer.from(key, 'hex');
  const derived = (await scrypt(password, salt, keyBuffer.length)) as Buffer;
  if (derived.length !== keyBuffer.length) return false;
  return timingSafeEqual(derived, keyBuffer);
}
