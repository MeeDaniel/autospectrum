import { createHash, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { blockStaff, createStaff, hashPassword, registerAuthRoutes, resetStaff } from './auth';

function deferred<T = void>() {
  let resolve!: (value?: T) => void;
  const promise = new Promise<T>(done => { resolve = value => done(value as T); });
  return { promise, resolve };
}

class ConcurrentAccountPool {
  readonly beforeInsert = deferred();
  readonly resumeInsert = deferred();
  readonly waitingForAccount = deferred();
  readonly sessions = new Map<string, boolean>();
  private accountOwner?: ConcurrentClient;
  private accountWaiters: Array<() => void> = [];
  private blocked = false;

  constructor(private passwordHash: string) {}

  async connect() { return new ConcurrentClient(this); }

  async query(sql: string, values: unknown[] = []) {
    if (sql.startsWith('SELECT u.id, u.login, u.role, s.csrf_hash')) {
      const active = this.sessions.get(values[0] as string);
      return { rows: active && !this.blocked ? [{ id: 'staff-1', login: 'desk', role: 'staff', csrf_hash: '', csrf_token: '' }] : [] };
    }
    throw new Error(`Unexpected pool query: ${sql}`);
  }

  async lockAccount(client: ConcurrentClient) {
    if (this.accountOwner === client) return;
    if (this.accountOwner) {
      this.waitingForAccount.resolve();
      await new Promise<void>(resolve => this.accountWaiters.push(resolve));
    }
    this.accountOwner = client;
  }

  unlockAccount(client: ConcurrentClient) {
    if (this.accountOwner !== client) return;
    this.accountOwner = undefined;
    this.accountWaiters.shift()?.();
  }

  get user() { return this.blocked ? undefined : { id: 'staff-1', login: 'desk', role: 'staff', blocked_at: null, password_hash: this.passwordHash }; }
  setPassword(hash: string) { this.passwordHash = hash; }
  block() { this.blocked = true; }
  revokeSessions() { for (const key of this.sessions.keys()) this.sessions.set(key, false); }
}

class ConcurrentClient {
  constructor(private pool: ConcurrentAccountPool) {}
  release() {}

  async query(sql: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    if (sql === 'BEGIN') return { rows: [] };
    if (sql === 'COMMIT' || sql === 'ROLLBACK') { this.pool.unlockAccount(this); return { rows: [] }; }
    if (sql.startsWith('SELECT pg_advisory_xact_lock') || sql.startsWith('DELETE FROM staff_login_attempts') || sql.startsWith('INSERT INTO audit_log')) return { rows: [] };
    if (sql.startsWith('SELECT count(')) return { rows: [{ total: '0' }] };
    if (sql.startsWith('SELECT id, login, role, password_hash') || sql.startsWith('SELECT id, login, role, blocked_at')) {
      if (sql.includes('FOR UPDATE')) await this.pool.lockAccount(this);
      const user = this.pool.user;
      return { rows: user ? [user] : [] };
    }
    if (sql.startsWith('INSERT INTO staff_sessions')) {
      this.pool.beforeInsert.resolve();
      await this.pool.resumeInsert.promise;
      this.pool.sessions.set(values[0] as string, true);
      return { rows: [] };
    }
    if (sql.startsWith('UPDATE staff_users SET password_hash')) {
      await this.pool.lockAccount(this);
      this.pool.setPassword(values[0] as string);
      return { rows: [{ id: 'staff-1' }] };
    }
    if (sql.startsWith('UPDATE staff_users SET blocked_at')) {
      await this.pool.lockAccount(this);
      this.pool.block();
      return { rows: [{ id: 'staff-1' }] };
    }
    if (sql.startsWith('UPDATE staff_sessions SET revoked_at')) { this.pool.revokeSessions(); return { rows: [] }; }
    throw new Error(`Unexpected client query: ${sql}`);
  }
}

describe('staff account login concurrency', () => {
  for (const action of ['reset', 'block'] as const) {
    it(`${action} revokes a login paused before session insertion`, async () => {
      const pool = new ConcurrentAccountPool(await hashPassword('old password 123'));
      const app = Fastify();
      registerAuthRoutes(app, pool as never);
      try {
        const login = app.inject({ method: 'POST', url: '/api/admin/login', payload: { login: 'desk', password: 'old password 123' } });
        await pool.beforeInsert.promise;
        const maintenance = action === 'reset' ? resetStaff(pool as never, 'desk', 'new password 123') : blockStaff(pool as never, 'desk');
        const first = await Promise.race([maintenance.then(() => 'maintenance'), pool.waitingForAccount.promise.then(() => 'lock')]);
        pool.resumeInsert.resolve();
        const signedIn = await login;
        await maintenance;
        expect(signedIn.statusCode).toBe(200);
        const cookie = signedIn.headers['set-cookie'] as string;
        const token = cookie.match(/autospectrum_session=([a-f0-9]{64})/)?.[1];
        expect(token).toBeTruthy();
        const tokenHash = createHash('sha256').update(token!).digest('hex');
        expect(pool.sessions.get(tokenHash)).toBe(false);
        expect((await app.inject({ method: 'GET', url: '/api/admin/me', headers: { cookie } })).statusCode).toBe(401);
        if (action === 'reset') {
          expect((await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login: 'desk', password: 'new password 123' } })).statusCode).toBe(200);
        }
        expect(first).toBe('lock');
      } finally {
        pool.resumeInsert.resolve();
        await app.close();
      }
    });
  }
});

type QueryGate = { reached: ReturnType<typeof deferred>; resume: ReturnType<typeof deferred> };

function gatedPool(pool: Pool, options: { insert?: QueryGate; resetCommit?: QueryGate; loginSelect?: ReturnType<typeof deferred<number>>; managementStart?: ReturnType<typeof deferred<number>> }) {
  return {
    async connect() {
      const client = await pool.connect();
      const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      let resetting = false;
      return {
        release: () => client.release(),
        async query(sql: string, values?: unknown[]) {
          if (sql.startsWith('UPDATE staff_users SET password_hash')) resetting = true;
          if (sql.startsWith('INSERT INTO staff_sessions') && options.insert) {
            options.insert.reached.resolve();
            await options.insert.resume.promise;
          }
          if (sql === 'COMMIT' && resetting && options.resetCommit) {
            options.resetCommit.reached.resolve();
            await options.resetCommit.resume.promise;
          }
          const pending = client.query(sql, values as never);
          if (sql.startsWith('SELECT id, login, role, password_hash')) options.loginSelect?.resolve(pid);
          if (sql.startsWith('SELECT pg_advisory_xact_lock') && sql.includes('autospectrum_staff_management')) options.managementStart?.resolve(pid);
          return pending;
        },
      };
    },
    query: (sql: string, values?: unknown[]) => pool.query(sql, values as never),
  };
}

async function lockOrFinished(pool: Pool, pid: number, operation: Promise<unknown>): Promise<'lock' | 'finished'> {
  let stop = false;
  try {
    return await Promise.race([
      operation.then(() => 'finished' as const),
      (async () => {
        while (!stop) {
          const result = await pool.query<{ wait_event_type: string | null }>('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid]);
          if (result.rows[0]?.wait_event_type === 'Lock') return 'lock' as const;
          await new Promise<void>(resolve => setImmediate(resolve));
        }
        return 'finished' as const;
      })(),
    ]);
  } finally {
    stop = true;
  }
}

const connectionString = process.env.INTEGRATION_TEST_DATABASE_URL;
const pgRun = connectionString ? describe : describe.skip;

pgRun('PostgreSQL staff login concurrency', () => {
  const pool = new Pool({ connectionString });
  afterAll(async () => { await pool.end(); });

  async function fixture() {
    const parsed = new URL(connectionString!);
    if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || !/(test|integration)/i.test(decodeURIComponent(parsed.pathname))) {
      throw new Error('INTEGRATION_TEST_DATABASE_URL must name an isolated local test database');
    }
    const login = `race-${randomUUID().slice(0, 12)}`;
    const staff = await createStaff(pool, login, 'old password 123');
    const cleanup = async () => {
      await pool.query('DELETE FROM staff_sessions WHERE staff_id = $1', [staff.id]);
      await pool.query('DELETE FROM audit_log WHERE entity = $1 AND entity_id = $2', ['staff', staff.id]);
      await pool.query('DELETE FROM staff_login_attempts WHERE login = $1', [login]);
      await pool.query('DELETE FROM staff_users WHERE id = $1', [staff.id]);
    };
    return { login, staff, cleanup };
  }

  it('revokes a login session when login holds the account row before reset', async () => {
    const { login, staff, cleanup } = await fixture();
    const insert: QueryGate = { reached: deferred(), resume: deferred() };
    const managementStart = deferred<number>();
    const db = gatedPool(pool, { insert, managementStart });
    const app = Fastify();
    registerAuthRoutes(app, db as never);
    const pending: Promise<unknown>[] = [];
    try {
      const signingIn = app.inject({ method: 'POST', url: '/api/admin/login', payload: { login, password: 'old password 123' } });
      pending.push(signingIn);
      await insert.reached.promise;
      const resetting = resetStaff(db as never, login, 'new password 123');
      pending.push(resetting);
      const pid = await managementStart.promise;
      const state = await lockOrFinished(pool, pid, resetting);
      insert.resume.resolve();
      const signedIn = await signingIn;
      await resetting;
      expect(state).toBe('lock');
      expect(signedIn.statusCode).toBe(200);
      const cookie = signedIn.headers['set-cookie'] as string;
      const token = cookie.match(/autospectrum_session=([a-f0-9]{64})/)?.[1];
      expect(token).toBeTruthy();
      const session = await pool.query<{ revoked_at: Date | null }>('SELECT revoked_at FROM staff_sessions WHERE staff_id = $1 AND token_hash = $2', [staff.id, createHash('sha256').update(token!).digest('hex')]);
      expect(session.rows[0]?.revoked_at).toBeInstanceOf(Date);
      expect((await app.inject({ method: 'GET', url: '/api/admin/me', headers: { cookie } })).statusCode).toBe(401);
    } finally {
      insert.resume.resolve();
      await Promise.allSettled(pending);
      await app.close();
      await cleanup();
    }
  }, 15000);

  it('rejects the old password when reset holds the account row first', async () => {
    const { login, cleanup } = await fixture();
    const resetCommit: QueryGate = { reached: deferred(), resume: deferred() };
    const loginSelect = deferred<number>();
    const db = gatedPool(pool, { resetCommit, loginSelect });
    const app = Fastify();
    registerAuthRoutes(app, db as never);
    const pending: Promise<unknown>[] = [];
    try {
      const resetting = resetStaff(db as never, login, 'new password 123');
      pending.push(resetting);
      await resetCommit.reached.promise;
      const oldLogin = app.inject({ method: 'POST', url: '/api/admin/login', payload: { login, password: 'old password 123' } });
      pending.push(oldLogin);
      const pid = await loginSelect.promise;
      const state = await lockOrFinished(pool, pid, oldLogin);
      resetCommit.resume.resolve();
      await resetting;
      const oldResult = await oldLogin;
      expect(state).toBe('lock');
      expect(oldResult.statusCode).toBe(401);
      const replacement = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login, password: 'new password 123' } });
      expect(replacement.statusCode).toBe(200);
    } finally {
      resetCommit.resume.resolve();
      await Promise.allSettled(pending);
      await app.close();
      await cleanup();
    }
  }, 15000);

  it('keeps a blocked account from using a login session already in flight', async () => {
    const { login, staff, cleanup } = await fixture();
    const insert: QueryGate = { reached: deferred(), resume: deferred() };
    const managementStart = deferred<number>();
    const db = gatedPool(pool, { insert, managementStart });
    const app = Fastify();
    registerAuthRoutes(app, db as never);
    const pending: Promise<unknown>[] = [];
    try {
      const signingIn = app.inject({ method: 'POST', url: '/api/admin/login', payload: { login, password: 'old password 123' } });
      pending.push(signingIn);
      await insert.reached.promise;
      const blocking = blockStaff(db as never, login);
      pending.push(blocking);
      const pid = await managementStart.promise;
      const state = await lockOrFinished(pool, pid, blocking);
      insert.resume.resolve();
      const signedIn = await signingIn;
      await blocking;
      expect(state).toBe('lock');
      expect(signedIn.statusCode).toBe(200);
      const cookie = signedIn.headers['set-cookie'] as string;
      const sessions = await pool.query<{ revoked_at: Date | null }>('SELECT revoked_at FROM staff_sessions WHERE staff_id = $1', [staff.id]);
      expect(sessions.rows).toHaveLength(1);
      expect(sessions.rows[0].revoked_at).toBeInstanceOf(Date);
      expect((await app.inject({ method: 'GET', url: '/api/admin/me', headers: { cookie } })).statusCode).toBe(401);
    } finally {
      insert.resume.resolve();
      await Promise.allSettled(pending);
      await app.close();
      await cleanup();
    }
  }, 15000);
});
