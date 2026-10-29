import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { StaffAccount, StaffRole } from '../src/domain/staff';
import { appendAudit, hashPassword } from './auth';

type AccountRow = { id: string; login: string; role: StaffRole; blocked_at: Date | null };
type Target = { id: string } | { login: string };

export class StaffManagementError extends Error {
  constructor(public readonly status: 401 | 403 | 404 | 409 | 422, public readonly code: string, message: string) {
    super(message);
  }
}

export function normalizeStaffLogin(value: unknown): string {
  const login = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[a-z0-9._@-]{3,64}$/.test(login)) throw new StaffManagementError(422, 'invalid', 'Логин должен содержать 3–64 допустимых символа');
  return login;
}

export function validateStaffPassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < 12 || value.length > 1024) throw new StaffManagementError(422, 'invalid', 'Пароль должен содержать 12–1024 символа');
  return value;
}

export function validateStaffRole(value: unknown): StaffRole {
  if (value !== 'staff' && value !== 'operator') throw new StaffManagementError(422, 'invalid', 'Выберите роль сотрудника');
  return value;
}

function publicAccount(row: AccountRow): StaffAccount {
  return { id: row.id, login: row.login, role: row.role, blocked: row.blocked_at !== null };
}

async function managementTransaction<T>(pool: Pool, actorId: string | null, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('autospectrum_staff_management'))");
    if (actorId !== null) {
      const actor = await client.query<AccountRow>('SELECT id, login, role, blocked_at FROM staff_users WHERE id = $1 FOR UPDATE', [actorId]);
      if (!actor.rows[0] || actor.rows[0].blocked_at) throw new StaffManagementError(401, 'unauthorized', 'Сессия больше не действительна');
      if (actor.rows[0].role !== 'operator') throw new StaffManagementError(403, 'forbidden', 'Недостаточно прав');
    }
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function lockedAccount(client: PoolClient, target: Target): Promise<AccountRow> {
  const column = 'id' in target ? 'id' : 'login';
  const value = 'id' in target ? target.id : target.login;
  const account = await client.query<AccountRow>(`SELECT id, login, role, blocked_at FROM staff_users WHERE ${column} = $1 FOR UPDATE`, [value]);
  if (!account.rows[0]) throw new StaffManagementError(404, 'not_found', 'Сотрудник не найден');
  return account.rows[0];
}

async function requireAnotherActiveOperator(client: PoolClient): Promise<void> {
  const result = await client.query<{ total: string }>("SELECT count(*)::text AS total FROM staff_users WHERE role = 'operator' AND blocked_at IS NULL");
  if (Number(result.rows[0]?.total ?? 0) <= 1) throw new StaffManagementError(409, 'final_operator', 'Нельзя убрать последнего действующего оператора');
}

async function revokeSessions(client: PoolClient, id: string): Promise<void> {
  await client.query('UPDATE staff_sessions SET revoked_at = now() WHERE staff_id = $1 AND revoked_at IS NULL', [id]);
}

export async function listStaffAccounts(pool: Pool): Promise<StaffAccount[]> {
  const result = await pool.query<AccountRow>('SELECT id, login, role, blocked_at FROM staff_users ORDER BY login');
  return result.rows.map(publicAccount);
}

export async function createStaff(pool: Pool, loginValue: string, passwordValue: string, roleValue: StaffRole = 'staff', actorId: string | null = null): Promise<StaffAccount> {
  const login = normalizeStaffLogin(loginValue);
  const password = validateStaffPassword(passwordValue);
  const role = validateStaffRole(roleValue);
  const id = randomUUID();
  const hash = await hashPassword(password);
  try {
    return await managementTransaction(pool, actorId, async client => {
      await client.query('INSERT INTO staff_users (id, login, password_hash, role) VALUES ($1, $2, $3, $4)', [id, login, hash, role]);
      await appendAudit(client, actorId, 'staff.create', 'staff', id, { role });
      return { id, login, role, blocked: false };
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') throw new StaffManagementError(409, 'duplicate_login', 'Логин уже занят');
    throw error;
  }
}

export async function updateStaffAccount(pool: Pool, id: string, patch: { role?: StaffRole; blocked?: boolean }, actorId: string | null): Promise<StaffAccount> {
  return managementTransaction(pool, actorId, async client => {
    const account = await lockedAccount(client, { id });
    if (actorId === id && patch.role !== undefined) throw new StaffManagementError(409, 'self_change', 'Нельзя менять свою роль');
    if (actorId === id && patch.blocked === true) throw new StaffManagementError(409, 'self_change', 'Нельзя блокировать себя');
    const nextRole = patch.role ?? account.role;
    const nextBlocked = patch.blocked ?? (account.blocked_at !== null);
    if (account.role === 'operator' && account.blocked_at === null && (nextRole !== 'operator' || nextBlocked)) await requireAnotherActiveOperator(client);
    const changed = nextRole !== account.role || nextBlocked !== (account.blocked_at !== null);
    if (!changed) return publicAccount(account);
    const result = await client.query<AccountRow>('UPDATE staff_users SET role = $1, blocked_at = CASE WHEN $2 THEN COALESCE(blocked_at, now()) ELSE NULL END WHERE id = $3 RETURNING id, login, role, blocked_at', [nextRole, nextBlocked, id]);
    if (nextRole !== account.role || nextBlocked) await revokeSessions(client, id);
    const action = nextRole !== account.role ? 'staff.role' : nextBlocked ? 'staff.block' : 'staff.unblock';
    await appendAudit(client, actorId, action, 'staff', id, { role: nextRole, blocked: nextBlocked });
    return publicAccount(result.rows[0]);
  });
}

export async function resetStaffPassword(pool: Pool, target: Target, passwordValue: string, actorId: string | null): Promise<void> {
  const password = validateStaffPassword(passwordValue);
  const hash = await hashPassword(password);
  await managementTransaction(pool, actorId, async client => {
    const account = await lockedAccount(client, target);
    await client.query('UPDATE staff_users SET password_hash = $1 WHERE id = $2', [hash, account.id]);
    await revokeSessions(client, account.id);
    await appendAudit(client, actorId, 'staff.reset_password', 'staff', account.id);
  });
}

export async function blockStaff(pool: Pool, login: string): Promise<void> {
  const normalized = normalizeStaffLogin(login);
  await managementTransaction(pool, null, async client => {
    const account = await lockedAccount(client, { login: normalized });
    if (account.role === 'operator' && account.blocked_at === null) await requireAnotherActiveOperator(client);
    if (account.blocked_at !== null) return;
    await client.query('UPDATE staff_users SET blocked_at = now() WHERE id = $1', [account.id]);
    await revokeSessions(client, account.id);
    await appendAudit(client, null, 'staff.block', 'staff', account.id);
  });
}

export async function resetStaff(pool: Pool, login: string, password: string): Promise<void> {
  await resetStaffPassword(pool, { login: normalizeStaffLogin(login) }, password, null);
}

export async function setStaffRole(pool: Pool, login: string, roleValue: StaffRole): Promise<StaffAccount> {
  const normalized = normalizeStaffLogin(login);
  const role = validateStaffRole(roleValue);
  return managementTransaction(pool, null, async client => {
    const account = await lockedAccount(client, { login: normalized });
    if (account.role === role) return publicAccount(account);
    if (account.role === 'operator' && account.blocked_at === null) await requireAnotherActiveOperator(client);
    const result = await client.query<AccountRow>('UPDATE staff_users SET role = $1 WHERE id = $2 RETURNING id, login, role, blocked_at', [role, account.id]);
    await revokeSessions(client, account.id);
    await appendAudit(client, null, 'staff.role', 'staff', account.id, { role });
    return publicAccount(result.rows[0]);
  });
}

export async function unblockStaff(pool: Pool, login: string): Promise<void> {
  const normalized = normalizeStaffLogin(login);
  await managementTransaction(pool, null, async client => {
    const account = await lockedAccount(client, { login: normalized });
    if (account.blocked_at === null) return;
    await client.query('UPDATE staff_users SET blocked_at = NULL WHERE id = $1', [account.id]);
    await appendAudit(client, null, 'staff.unblock', 'staff', account.id);
  });
}
