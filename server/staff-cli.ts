import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { blockStaff, createStaff, resetStaff } from './auth';
import { setStaffRole, unblockStaff, validateStaffRole } from './staff-management';

const [command, login, ...extra] = process.argv.slice(2);
if (!['create', 'block', 'reset', 'role', 'unblock'].includes(command) || !login || (command === 'role' ? extra.length !== 1 : extra.length !== 0)) {
  process.stderr.write('Usage: tsx server/staff-cli.ts <create|block|reset|unblock> <login>\n       tsx server/staff-cli.ts role <login> <staff|operator>\nFor create/reset, provide the password on stdin.\n');
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
  } else if (command === 'unblock') {
    await unblockStaff(pool, login);
    process.stdout.write(`Unblocked ${login}.\n`);
  } else if (command === 'role') {
    const account = await setStaffRole(pool, login, validateStaffRole(extra[0]));
    process.stdout.write(`Role for ${account.login}: ${account.role}.\n`);
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
