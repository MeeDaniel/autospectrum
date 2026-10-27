import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { createStaff } from './auth';
import { blockStaff, setStaffRole, updateStaffAccount } from './staff-management';
import { runMigrations } from './migrate';

const connectionString = process.env.INTEGRATION_TEST_DATABASE_URL;
const run = connectionString ? describe : describe.skip;

run('staff roles in PostgreSQL', () => {
  const schema = `roles_${randomUUID().replace(/-/g, '')}`;
  const legacyId = randomUUID();
  const adminPool = new Pool({ connectionString });
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  const app = buildApp(pool);
  const owned: { id: string; login: string }[] = [];
  beforeAll(async () => {
    const url = new URL(connectionString!);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !/test|integration/i.test(url.pathname)) {
      throw new Error('INTEGRATION_TEST_DATABASE_URL must be an isolated local test database');
    }
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    for (const name of ['001_core.sql', '002_auth.sql']) {
      await pool.query(readFileSync(fileURLToPath(new URL(`./migrations/${name}`, import.meta.url)), 'utf8'));
    }
    await pool.query('INSERT INTO staff_users (id, login, password_hash) VALUES ($1, $2, $3)', [legacyId, 'legacy-staff', 'legacy-hash']);
    await runMigrations(pool, fileURLToPath(new URL('./migrations/', import.meta.url)));
  });
  afterEach(async () => {
    for (const account of owned) {
      await pool.query('DELETE FROM staff_sessions WHERE staff_id = $1', [account.id]);
      await pool.query('DELETE FROM audit_log WHERE entity = $1 AND entity_id = $2', ['staff', account.id]);
      await pool.query('DELETE FROM audit_log WHERE actor_id = $1', [account.id]);
      await pool.query('DELETE FROM staff_login_attempts WHERE login = $1', [account.login]);
      await pool.query('DELETE FROM staff_users WHERE id = $1', [account.id]);
    }
    owned.length = 0;
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  });

  async function fixture(role: 'staff' | 'operator' = 'staff') {
    const login = `role-${randomUUID().slice(0, 12)}`;
    const account = await createStaff(pool, login, 'fixture password 123');
    owned.push(account);
    if (role === 'operator') await pool.query("UPDATE staff_users SET role = 'operator' WHERE id = $1", [account.id]);
    const response = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login, password: 'fixture password 123' } });
    expect(response.statusCode).toBe(200);
    const cookie = String(response.headers['set-cookie']).split(';')[0];
    return { ...account, cookie, csrf: response.json().csrfToken as string };
  }

  it('migrates existing users to staff and defaults new users to staff', async () => {
    const legacy = await pool.query<{ role: string }>('SELECT role FROM staff_users WHERE id = $1', [legacyId]);
    expect(legacy.rows[0].role).toBe('staff');
    const account = await fixture();
    const row = await pool.query<{ role: string }>('SELECT role FROM staff_users WHERE id = $1', [account.id]);
    expect(row.rows[0].role).toBe('staff');
    expect((await app.inject({ url: '/api/admin/me', headers: { cookie: account.cookie } })).json().staff.role).toBe('staff');
  });

  it('forbids staff from direct audit and account endpoints while retaining ordinary admin access', async () => {
    const account = await fixture();
    expect((await app.inject({ url: '/api/admin/snapshot', headers: { cookie: account.cookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/admin/audit', headers: { cookie: account.cookie } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/admin/staff', headers: { cookie: account.cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/admin/staff', headers: { cookie: account.cookie, 'x-csrf-token': account.csrf }, payload: { login: 'forbidden-user', password: 'a long password 123', role: 'operator' } })).statusCode).toBe(403);
  });

  it('validates account writes and requires a live operator session and CSRF token', async () => {
    const operator = await fixture('operator');
    const headers = { cookie: operator.cookie, 'x-csrf-token': operator.csrf };
    expect((await app.inject({ url: '/api/admin/staff' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/admin/staff', headers: { cookie: operator.cookie }, payload: { login: 'new-user', password: 'a long password', role: 'staff' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/admin/staff', headers, payload: { login: 'new-user', password: 'a long password' } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url: '/api/admin/staff', headers, payload: { login: 'new-user', password: 'short', role: 'staff' } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'PATCH', url: `/api/admin/staff/${operator.id}`, headers, payload: { login: 'renamed' } })).statusCode).toBe(422);
    const listed = (await app.inject({ url: '/api/admin/staff', headers })).json() as { login: string }[];
    expect(listed.map(account => account.login)).toEqual(listed.map(account => account.login).sort());
  });

  it('creates, updates, resets and blocks accounts with safe responses and revoked sessions', async () => {
    const operator = await fixture('operator');
    const headers = { cookie: operator.cookie, 'x-csrf-token': operator.csrf };
    const login = `created-${randomUUID().slice(0, 12)}`;
    const created = await app.inject({ method: 'POST', url: '/api/admin/staff', headers, payload: { login, password: 'creation secret 123', role: 'staff' } });
    expect(created.statusCode).toBe(201);
    const account = created.json();
    owned.push({ id: account.id, login });
    expect(account).toEqual({ id: expect.any(String), login, role: 'staff', blocked: false });
    const listed = await app.inject({ url: '/api/admin/staff', headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual(expect.arrayContaining([account]));
    expect(JSON.stringify(listed.json())).not.toContain('creation secret');
    expect((await app.inject({ method: 'POST', url: '/api/admin/staff', headers, payload: { login, password: 'creation secret 123', role: 'staff' } })).statusCode).toBe(409);
    const signedIn = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login, password: 'creation secret 123' } });
    const oldCookie = String(signedIn.headers['set-cookie']).split(';')[0];
    expect((await app.inject({ method: 'PATCH', url: `/api/admin/staff/${account.id}`, headers, payload: { role: 'operator' } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/admin/me', headers: { cookie: oldCookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/api/admin/staff/${account.id}/password`, headers, payload: { password: 'replacement secret 123' } })).statusCode).toBe(204);
    expect((await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login, password: 'creation secret 123' } })).statusCode).toBe(401);
    const replacementLogin = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login, password: 'replacement secret 123' } });
    expect(replacementLogin.statusCode).toBe(200);
    const replacementCookie = String(replacementLogin.headers['set-cookie']).split(';')[0];
    const audit = await pool.query<{ details: unknown }>('SELECT details FROM audit_log WHERE entity_id = $1', [account.id]);
    expect(JSON.stringify(audit.rows)).not.toContain('secret');
    expect((await app.inject({ method: 'PATCH', url: `/api/admin/staff/${account.id}`, headers, payload: { blocked: true } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login, password: 'replacement secret 123' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PATCH', url: `/api/admin/staff/${account.id}`, headers, payload: { blocked: false } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/admin/me', headers: { cookie: replacementCookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login, password: 'replacement secret 123' } })).statusCode).toBe(200);
  });

  it('rejects self-demotion, self-block and removal of the final active operator', async () => {
    const operator = await fixture('operator');
    const headers = { cookie: operator.cookie, 'x-csrf-token': operator.csrf };
    expect((await app.inject({ method: 'PATCH', url: `/api/admin/staff/${operator.id}`, headers, payload: { role: 'staff' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'PATCH', url: `/api/admin/staff/${operator.id}`, headers, payload: { blocked: true } })).statusCode).toBe(409);
  });

  it('allows explicit first-operator promotion in maintenance but protects the final operator', async () => {
    const account = await fixture();
    expect((await setStaffRole(pool, account.login, 'operator')).role).toBe('operator');
    await expect(blockStaff(pool, account.login)).rejects.toMatchObject({ code: 'final_operator', status: 409 });
    expect((await pool.query<{ role: string; blocked: boolean }>('SELECT role, blocked_at IS NOT NULL AS blocked FROM staff_users WHERE id = $1', [account.id])).rows[0]).toEqual({ role: 'operator', blocked: false });
  });

  it('serializes simultaneous removals and keeps one active operator', async () => {
    const first = await fixture('operator');
    const second = await fixture('operator');
    const results = await Promise.allSettled([
      updateStaffAccount(pool, first.id, { role: 'staff' }, second.id),
      updateStaffAccount(pool, second.id, { role: 'staff' }, first.id),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const active = await pool.query<{ total: string }>("SELECT count(*)::text AS total FROM staff_users WHERE role = 'operator' AND blocked_at IS NULL");
    expect(active.rows[0].total).toBe('1');
  });
});
