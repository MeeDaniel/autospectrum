import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { blockStaff, createStaff, resetStaff } from './auth';

const [command, login, ...extra] = process.argv.slice(2);
if (!['create', 'block', 'reset'].includes(command) || !login || extra.length) {
  process.stderr.write('Usage: tsx server/staff-cli.ts <create|block|reset> <login>\nFor create/reset, provide the password on stdin.\n');
  process.exit(2);
}

if (!process.env.DATABASE_URL) {
  process.stderr.write('DATABASE_URL is required.\n');
  process.exit(2);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  if (command === 'block') {
    await blockStaff(pool, login);
    process.stdout.write(`Blocked ${login}.\n`);
  } else {
    const password = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
    if (command === 'create') {
      const staff = await createStaff(pool, login, password);
      process.stdout.write(`Created ${staff.login}.\n`);
    } else {
      await resetStaff(pool, login, password);
      process.stdout.write(`Reset password for ${login}.\n`);
    }
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
