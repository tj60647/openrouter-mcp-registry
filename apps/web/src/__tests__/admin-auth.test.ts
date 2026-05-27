import { describe, expect, it } from 'vitest';
import { hashAdminPassword, normalizeAdminUsername, verifyAdminPassword } from '../lib/adminAuth';

describe('adminAuth', () => {
  it('hashes and verifies a password', async () => {
    const hash = await hashAdminPassword('super-secret');
    await expect(verifyAdminPassword('super-secret', hash)).resolves.toBe(true);
  });

  it('rejects an invalid password', async () => {
    const hash = await hashAdminPassword('super-secret');
    await expect(verifyAdminPassword('wrong-password', hash)).resolves.toBe(false);
  });

  it('rejects malformed hashes', async () => {
    await expect(verifyAdminPassword('super-secret', 'bad-hash')).resolves.toBe(false);
  });

  it('normalizes usernames consistently', () => {
    expect(normalizeAdminUsername(' Admin.User ')).toBe('admin.user');
  });
});
