import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql } from '@vercel/postgres';

function loadLocalEnvIfPresent() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const envPath = path.resolve(__dirname, '..', '.env.local');

  if (!fs.existsSync(envPath)) {
    return;
  }

  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function getArgValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}

function normalizeUsername(username) {
  return username.trim().toLowerCase();
}

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = scryptSync(password, salt, 64);
  return `scrypt$${salt}$${derivedKey.toString('hex')}`;
}

async function createAdmin() {
  loadLocalEnvIfPresent();

  if (!process.env.POSTGRES_URL) {
    throw new Error('POSTGRES_URL is not set. Add it to apps/web/.env.local or your shell environment.');
  }

  const rawUsername =
    getArgValue('--username') ??
    process.env.ADMIN_BOOTSTRAP_USERNAME ??
    'admin';
  const password =
    getArgValue('--password') ??
    process.env.ADMIN_BOOTSTRAP_PASSWORD;

  const username = normalizeUsername(rawUsername);
  if (!username) {
    throw new Error('Username must not be empty.');
  }

  if (!password) {
    throw new Error(
      'Password is required. Pass --password or set ADMIN_BOOTSTRAP_PASSWORD.'
    );
  }

  const passwordHash = hashPassword(password);

  await sql`
    INSERT INTO admins (username, password_hash, active)
    VALUES (${username}, ${passwordHash}, TRUE)
    ON CONFLICT (username)
    DO UPDATE SET
      password_hash = EXCLUDED.password_hash,
      active = TRUE,
      updated_at = NOW()
  `;

  console.log(`Admin user "${username}" created or updated.`);
}

createAdmin()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Create admin failed:', err);
    process.exit(1);
  });
