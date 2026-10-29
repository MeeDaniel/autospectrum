import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { Pool } from 'pg';
import type { StaffRole } from '../src/domain/staff';

const scrypt = promisify(scryptCallback);
const SESSION_COOKIE = 'autospectrum_session';

export type StaffPrincipal = { id: string; login: string; role: StaffRole };

declare module 'fastify' {
  interface FastifyRequest { staff?: StaffPrincipal; staffCsrfToken?: string }
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function cookieToken(request: FastifyRequest): string | undefined {
  const cookie = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${SESSION_COOKIE}=`));
  const token = cookie?.slice(SESSION_COOKIE.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}

export function requireStaff(pool: Pool, requiredRole?: StaffRole): preHandlerHookHandler {
  return async (request, reply) => {
    const token = cookieToken(request);
    if (!token) { reply.code(401).send({ error: 'unauthorized' }); return; }
    const result = await pool.query<{ id: string; login: string; role: StaffRole; csrf_hash: string; csrf_token: string }>(
      'SELECT u.id, u.login, u.role, s.csrf_hash, s.csrf_token FROM staff_sessions s JOIN staff_users u ON u.id = s.staff_id WHERE s.token_hash = $1 AND s.expires_at > now() AND s.revoked_at IS NULL AND u.blocked_at IS NULL',
      [digest(token)],
    );
    const staff = result.rows[0];
    if (!staff) { reply.code(401).send({ error: 'unauthorized' }); return; }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const provided = request.headers['x-csrf-token'];
      const csrf = typeof provided === 'string' && /^[a-f0-9]{64}$/.test(provided) ? digest(provided) : '';
      if (csrf.length !== staff.csrf_hash.length || !timingSafeEqual(Buffer.from(csrf), Buffer.from(staff.csrf_hash))) {
        reply.code(403).send({ error: 'csrf_required' }); return;
      }
    }
    if (requiredRole && staff.role !== requiredRole) { reply.code(403).send({ error: 'forbidden' }); return; }
    request.staff = { id: staff.id, login: staff.login, role: staff.role };
    request.staffCsrfToken = staff.csrf_token;
  };
}

const dummyHash = hashPassword('this account does not exist');

type LoginResult =
  | { kind: 'limited' }
  | { kind: 'invalid' }
  | { kind: 'ok'; staff: StaffPrincipal; token: string; csrfToken: string };

async function loginStaff(pool: Pool, login: string, password: string, ip: string): Promise<LoginResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [login, ip]);
    await client.query("DELETE FROM staff_login_attempts WHERE login = $1 AND ip = $2 AND failed_at < now() - interval '15 minutes'", [login, ip]);
    const count = await client.query<{ total: string }>('SELECT count(*)::text AS total FROM staff_login_attempts WHERE login = $1 AND ip = $2', [login, ip]);
    if (Number(count.rows[0]?.total ?? 0) >= 5) {
      await client.query('COMMIT');
      return { kind: 'limited' };
    }
    const found = await client.query<{ id: string; login: string; role: StaffRole; password_hash: string }>('SELECT id, login, role, password_hash FROM staff_users WHERE login = $1 AND blocked_at IS NULL FOR UPDATE', [login]);
    const user = found.rows[0];
    const valid = await verifyPassword(password, user?.password_hash ?? await dummyHash);
    if (!user || !valid) {
      await client.query('INSERT INTO staff_login_attempts (login, ip) VALUES ($1, $2)', [login, ip]);
      await client.query('COMMIT');
      return { kind: 'invalid' };
    }
    const token = randomBytes(32).toString('hex');
    const csrfToken = randomBytes(32).toString('hex');
    await client.query("INSERT INTO staff_sessions (token_hash, staff_id, csrf_hash, csrf_token, expires_at) VALUES ($1, $2, $3, $4, now() + interval '12 hours')", [digest(token), user.id, digest(csrfToken), csrfToken]);
    await client.query('DELETE FROM staff_login_attempts WHERE login = $1 AND ip = $2', [login, ip]);
    await appendAudit(client, user.id, 'auth.login', 'staff', user.id);
    await client.query('COMMIT');
    return { kind: 'ok', staff: { id: user.id, login: user.login, role: user.role }, token, csrfToken };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function registerAuthRoutes(app: FastifyInstance, pool: Pool): void {
  app.post('/api/admin/login', async (request, reply) => {
    const body = request.body as { login?: unknown; password?: unknown } | null;
    const login = typeof body?.login === 'string' ? body.login.trim().toLowerCase() : '';
    const password = body?.password;
    if (!/^[a-z0-9._@-]{3,64}$/.test(login) || typeof password !== 'string' || password.length > 1024) {
      return reply.code(400).send({ error: 'invalid_credentials' });
    }
    const result = await loginStaff(pool, login, password, request.ip);
    if (result.kind === 'limited') return reply.code(429).send({ error: 'too_many_attempts' });
    if (result.kind === 'invalid') return reply.code(401).send({ error: 'invalid_credentials' });
    reply.header('Set-Cookie', `${SESSION_COOKIE}=${result.token}; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`);
    return { staff: result.staff, csrfToken: result.csrfToken };
  });

  app.get('/api/admin/me', { preHandler: requireStaff(pool) }, async request => ({ staff: request.staff, csrfToken: request.staffCsrfToken }));

  app.post('/api/admin/logout', { preHandler: requireStaff(pool) }, async (request, reply) => {
    const token = cookieToken(request);
    await pool.query('UPDATE staff_sessions SET revoked_at = now() WHERE token_hash = $1', [digest(token!)]);
    await appendAudit(pool, request.staff!.id, 'auth.logout', 'staff', request.staff!.id);
    reply.header('Set-Cookie', `${SESSION_COOKIE}=; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
    return reply.code(204).send();
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64) as Buffer;
  return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt' || !/^[a-f0-9]{32}$/.test(parts[1]) || !/^[a-f0-9]{128}$/.test(parts[2])) return false;
  const expected = Buffer.from(parts[2], 'hex');
  const actual = await scrypt(password, Buffer.from(parts[1], 'hex'), expected.length) as Buffer;
  return timingSafeEqual(actual, expected);
}

export type Queryable = { query(sql: string, values: unknown[]): Promise<unknown> };

function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[redacted]')
      .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, '[redacted]');
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !/name|phone|email|contact|address|comment|customer|client|vin|plate/i.test(key)).map(([key, nested]) => [key, redact(nested)]));
  }
  return value;
}

export async function appendAudit(db: Queryable, actorId: string | null, action: string, entity: string, entityId: string | null, details: Record<string, unknown> = {}): Promise<void> {
  await db.query('INSERT INTO audit_log (actor_id, action, entity, entity_id, details) VALUES ($1, $2, $3, $4, $5::jsonb)', [actorId, action, entity, entityId, JSON.stringify(redact(details))]);
}

export type AuditEntry = {
  id: number;
  actor_id: string | null;
  actor_login: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  details: Record<string, unknown>;
  created_at: Date;
};

export type AuditFilters = { actorId?: string; entity?: string; entityId?: string; beforeId?: number; limit?: number };

export async function listAudit(pool: Pool, filters: AuditFilters = {}): Promise<AuditEntry[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (filters.actorId) { values.push(filters.actorId); conditions.push(`actor_id = $${values.length}`); }
  if (filters.entity) { values.push(filters.entity); conditions.push(`entity = $${values.length}`); }
  if (filters.entityId) { values.push(filters.entityId); conditions.push(`entity_id = $${values.length}`); }
  if (filters.beforeId !== undefined && Number.isSafeInteger(filters.beforeId) && filters.beforeId > 0) {
    values.push(filters.beforeId); conditions.push(`a.id < $${values.length}`);
  }
  values.push(Math.min(100, Math.max(1, Number.isSafeInteger(filters.limit) ? filters.limit! : 50)));
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const result = await pool.query<AuditEntry>(`SELECT a.id, a.actor_id, u.login AS actor_login, a.action, a.entity, a.entity_id, a.details, a.created_at FROM audit_log a LEFT JOIN staff_users u ON u.id = a.actor_id${where} ORDER BY a.id DESC LIMIT $${values.length}`, values);
  return result.rows;
}

export { createStaff, blockStaff, resetStaff } from './staff-management';
