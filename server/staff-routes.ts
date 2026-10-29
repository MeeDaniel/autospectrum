import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { requireStaff } from './auth';
import { createStaff, listStaffAccounts, resetStaffPassword, StaffManagementError, updateStaffAccount, validateStaffPassword, validateStaffRole } from './staff-management';

function bodyObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StaffManagementError(422, 'invalid', 'Проверьте данные сотрудника');
  return value as Record<string, unknown>;
}

function accountId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new StaffManagementError(422, 'invalid', 'Некорректный идентификатор');
  return value;
}

export function registerStaffRoutes(app: FastifyInstance, pool: Pool): void {
  const operator = requireStaff(pool, 'operator');
  app.get('/api/admin/staff', { preHandler: operator }, async () => listStaffAccounts(pool));
  app.post('/api/admin/staff', { preHandler: operator }, async (request, reply) => {
    const body = bodyObject(request.body);
    const account = await createStaff(pool, body.login as string, body.password as string, validateStaffRole(body.role), request.staff!.id);
    return reply.code(201).send(account);
  });
  app.patch<{ Params: { id: string } }>('/api/admin/staff/:id', { preHandler: operator }, async request => {
    const body = bodyObject(request.body);
    if (!Object.keys(body).length || Object.keys(body).some(key => key !== 'role' && key !== 'blocked')) throw new StaffManagementError(422, 'invalid', 'Проверьте изменения сотрудника');
    if ('blocked' in body && typeof body.blocked !== 'boolean') throw new StaffManagementError(422, 'invalid', 'Проверьте состояние сотрудника');
    const patch = { ...('role' in body ? { role: validateStaffRole(body.role) } : {}), ...('blocked' in body ? { blocked: body.blocked as boolean } : {}) };
    return updateStaffAccount(pool, accountId(request.params.id), patch, request.staff!.id);
  });
  app.post<{ Params: { id: string } }>('/api/admin/staff/:id/password', { preHandler: operator }, async (request, reply) => {
    const body = bodyObject(request.body);
    if (Object.keys(body).length !== 1 || !('password' in body)) throw new StaffManagementError(422, 'invalid', 'Проверьте пароль');
    await resetStaffPassword(pool, { id: accountId(request.params.id) }, validateStaffPassword(body.password), request.staff!.id);
    return reply.code(204).send();
  });
}
