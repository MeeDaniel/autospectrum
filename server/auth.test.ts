import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { appendAudit, blockStaff, createStaff, hashPassword, listAudit, registerAuthRoutes, requireStaff, resetStaff, verifyPassword } from './auth';

describe('staff password hashing', () => {
  it('uses a fresh salt and rejects a wrong password', async () => {
    const first = await hashPassword('correct horse battery staple');
    const second = await hashPassword('correct horse battery staple');
    expect(first).not.toBe(second);
    expect(first).not.toContain('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', first)).toBe(true);
    expect(await verifyPassword('wrong password', first)).toBe(false);
    expect(await verifyPassword('correct horse battery staple', 'invalid')).toBe(false);
  });
});

describe('audit record', () => {
  it('redacts contact fields and contact-like text before persistence', async () => {
    let recorded: unknown[] = [];
    const db = {
      async query(_sql: string, values: unknown[]) { recorded = values; return { rows: [] }; },
    };
    await appendAudit(db, 'staff-1', 'booking.update', 'booking', 'booking-1', {
      status: 'confirmed',
      customer: { name: 'Alice', phone: '+7 999 123 45 67', email: 'a@example.com' },
      note: 'Call +7 999 123 45 67 or a@example.com',
    });
    expect(recorded.slice(0, 4)).toEqual(['staff-1', 'booking.update', 'booking', 'booking-1']);
    expect(recorded[4]).toContain('"status":"confirmed"');
    expect(recorded[4]).not.toContain('Alice');
    expect(recorded[4]).not.toContain('999 123');
    expect(recorded[4]).not.toContain('a@example.com');
  });

  it('limits the audit feed with parameterized filters', async () => {
    let statement = '';
    let parameters: unknown[] = [];
    const db = { async query(sql: string, values: unknown[]) {
      statement = sql; parameters = values;
      return { rows: [{ id: 8, actor_id: 'staff-1', ...(sql.includes('LEFT JOIN staff_users') ? { actor_login: 'desk' } : {}), action: 'booking.update', entity: 'booking', entity_id: 'booking-1', details: { status: 'confirmed' }, created_at: new Date('2026-10-12T00:00:00Z') }] };
    } };
    const rows = await listAudit(db as never, { actorId: 'staff-1', entity: 'booking', beforeId: 9, limit: 20 });
    expect(parameters).toEqual(['staff-1', 'booking', 9, 20]);
    expect(statement).toContain('actor_id = $1');
    expect(statement).toContain('entity = $2');
    expect(statement).toContain('id < $3');
    expect(rows[0].details).toEqual({ status: 'confirmed' });
    expect(rows[0].actor_login).toBe('desk');
  });
});

describe('staff guard', () => {
  const token = 'a'.repeat(64);
  const staffRow = { id: 'staff-1', login: 'desk', csrf_hash: 'ignored' };

  function harness(row: typeof staffRow | undefined, method = 'GET', csrfHeader?: string) {
    const db = { async query() { return { rows: row ? [row] : [] }; } };
    const request = { headers: { cookie: `autospectrum_session=${token}`, ...(csrfHeader ? { 'x-csrf-token': csrfHeader } : {}) }, method, staff: undefined };
    const reply = { statusCode: 200, payload: undefined as unknown, code(code: number) { this.statusCode = code; return this; }, send(payload: unknown) { this.payload = payload; return this; } };
    return { db, request, reply };
  }

  it('rejects a missing or revoked session', async () => {
    const { db, request, reply } = harness(undefined);
    await requireStaff(db as never).call({} as never, request as never, reply as never, (() => {}) as never);
    expect(reply.statusCode).toBe(401);
    expect(request.staff).toBeUndefined();
  });

  it('rejects a write without the matching CSRF token', async () => {
    const { db, request, reply } = harness(staffRow, 'PATCH');
    await requireStaff(db as never).call({} as never, request as never, reply as never, (() => {}) as never);
    expect(reply.statusCode).toBe(403);
    expect(request.staff).toBeUndefined();
  });

  it('allows a read for an active staff session', async () => {
    const { db, request, reply } = harness(staffRow);
    await requireStaff(db as never).call({} as never, request as never, reply as never, (() => {}) as never);
    expect(reply.statusCode).toBe(200);
    expect(request.staff).toEqual({ id: 'staff-1', login: 'desk' });
  });
});

describe('admin authentication routes', () => {
  it('issues a secure session, exposes staff on reload, and requires CSRF to log out', async () => {
    const passwordHash = await hashPassword('a very long staff password');
    let session: { token_hash: string; csrf_hash: string; csrf_token: string } | undefined;
    const db = {
      async connect() { return this; },
      release() {},
      async query(sql: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
        if (sql.startsWith('SELECT count(')) return { rows: [{ total: '0' }] };
        if (sql.startsWith('SELECT id, login, password_hash')) return { rows: [{ id: 'staff-1', login: 'desk', password_hash: passwordHash }] };
        if (sql.startsWith('INSERT INTO staff_sessions')) {
          session = { token_hash: values[0] as string, csrf_hash: values[2] as string, csrf_token: values[3] as string };
        }
        if (sql.startsWith('SELECT u.id, u.login, s.csrf_hash') && session && values[0] === session.token_hash) {
          return { rows: [{ id: 'staff-1', login: 'desk', csrf_hash: session.csrf_hash, csrf_token: session.csrf_token }] };
        }
        if (sql.startsWith('UPDATE staff_sessions')) session = undefined;
        return { rows: [] };
      },
    };
    const app = Fastify();
    registerAuthRoutes(app, db as never);
    const login = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login: 'desk', password: 'a very long staff password' } });
    expect(login.statusCode).toBe(200);
    const cookie = login.headers['set-cookie'] as string;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Max-Age=43200');
    const csrfToken = login.json().csrfToken;
    const me = await app.inject({ method: 'GET', url: '/api/admin/me', headers: { cookie } });
    expect(me.json()).toEqual({ staff: { id: 'staff-1', login: 'desk' }, csrfToken });
    const rejected = await app.inject({ method: 'POST', url: '/api/admin/logout', headers: { cookie } });
    expect(rejected.statusCode).toBe(403);
    const logout = await app.inject({ method: 'POST', url: '/api/admin/logout', headers: { cookie, 'x-csrf-token': csrfToken } });
    expect(logout.statusCode).toBe(204);
    const revoked = await app.inject({ method: 'GET', url: '/api/admin/me', headers: { cookie } });
    expect(revoked.statusCode).toBe(401);
    await app.close();
  });

  it('locks a login and IP after five failed attempts in the window', async () => {
    let failures = 0;
    const db = {
      async connect() { return this; }, release() {},
      async query(sql: string) {
        if (sql.startsWith('SELECT count(')) return { rows: [{ total: String(failures) }] };
        if (sql.startsWith('SELECT id, login, password_hash')) return { rows: [] };
        if (sql.startsWith('INSERT INTO staff_login_attempts')) failures++;
        return { rows: [] };
      },
    };
    const app = Fastify();
    registerAuthRoutes(app, db as never);
    const attempts = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      attempts.push(await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login: 'desk', password: 'incorrect' } }));
    }
    expect(attempts.slice(0, 5).map(result => result.statusCode)).toEqual([401, 401, 401, 401, 401]);
    expect(attempts[5].statusCode).toBe(429);
    expect(failures).toBe(5);
    await app.close();
  });
});

describe('staff account maintenance', () => {
  it('creates a normalized staff login with a non-plaintext password', async () => {
    const statements: { sql: string; values: unknown[] }[] = [];
    const db = {
      async connect() { return this; }, release() {},
      async query(sql: string, values: unknown[] = []) { statements.push({ sql, values }); return { rows: [] }; },
    };
    const staff = await createStaff(db as never, '  Desk ', 'a very long staff password');
    const inserted = statements.find(entry => entry.sql.startsWith('INSERT INTO staff_users'))!;
    expect(staff).toEqual({ id: inserted.values[0], login: 'desk' });
    expect(inserted.values[1]).toBe('desk');
    expect(await verifyPassword('a very long staff password', inserted.values[2] as string)).toBe(true);
    expect(statements.at(-1)?.sql).toBe('COMMIT');
  });

  it('blocks a staff account and revokes every session', async () => {
    const statements: string[] = [];
    const db = {
      async connect() { return this; }, release() {},
      async query(sql: string) { statements.push(sql); return { rows: [{ id: 'staff-1' }] }; },
    };
    await blockStaff(db as never, 'desk');
    expect(statements.some(sql => sql.startsWith('UPDATE staff_users SET blocked_at'))).toBe(true);
    expect(statements.some(sql => sql.startsWith('UPDATE staff_sessions SET revoked_at'))).toBe(true);
    expect(statements.at(-1)).toBe('COMMIT');
  });

  it('resets the hash and revokes existing sessions', async () => {
    const statements: { sql: string; values: unknown[] }[] = [];
    const db = {
      async connect() { return this; }, release() {},
      async query(sql: string, values: unknown[] = []) { statements.push({ sql, values }); return { rows: [{ id: 'staff-1' }] }; },
    };
    await resetStaff(db as never, 'desk', 'replacement password');
    const updated = statements.find(entry => entry.sql.startsWith('UPDATE staff_users SET password_hash'))!;
    expect(await verifyPassword('replacement password', updated.values[0] as string)).toBe(true);
    expect(statements.some(entry => entry.sql.startsWith('UPDATE staff_sessions SET revoked_at'))).toBe(true);
    expect(statements.at(-1)?.sql).toBe('COMMIT');
  });
});
