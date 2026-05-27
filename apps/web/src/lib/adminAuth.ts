import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const PASSWORD_KEYLEN = 64;
const HASH_PREFIX = 'scrypt';

export function normalizeAdminUsername(username: string): string {
  return username.trim().toLowerCase();
}

export async function hashAdminPassword(password: string): Promise<string> {
  if (!password) {
    throw new Error('Password must not be empty');
  }

  const salt = randomBytes(16).toString('hex');
  const derivedKey = (await scrypt(password, salt, PASSWORD_KEYLEN)) as Buffer;
  return `${HASH_PREFIX}$${salt}$${derivedKey.toString('hex')}`;
}

export async function verifyAdminPassword(password: string, storedHash: string): Promise<boolean> {
  const [prefix, salt, expectedHex] = storedHash.split('$');
  if (prefix !== HASH_PREFIX || !salt || !expectedHex || expectedHex.length % 2 !== 0) {
    return false;
  }

  const expected = Buffer.from(expectedHex, 'hex');
  const derivedKey = (await scrypt(password, salt, expected.length)) as Buffer;

  return derivedKey.length === expected.length && timingSafeEqual(derivedKey, expected);
}
