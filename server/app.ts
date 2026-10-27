import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import Fastify, { LogController } from 'fastify';
import { Pool } from 'pg';
import type { AdminBooking, BookingInput, CategoryInput, ServiceInput, SettingsInput } from '../src/domain/admin';
import type { BookingDraft } from '../src/domain/booking';
import { appendAudit, listAudit, registerAuthRoutes, requireStaff } from './auth';
import { createDataLayer, DataValidationError, IdempotencyConflictError, NotFoundError, RevisionConflictError, ScheduleConflictError, SubmissionRejectedError } from './data';
import { safeError } from './request-logging';

type DataLayer = ReturnType<typeof createDataLayer>;
type SaveBody<T> = { input: T; allowConflicts?: boolean };
type IdParams = { id: string };

export function buildApp(pool: Pool, data: DataLayer = createDataLayer(pool, {
  audit: async (client, actorId, action, entity, entityId, before, after) => {
    const changedFields = Array.from(new Set([...Object.keys((before ?? {}) as object), ...Object.keys((after ?? {}) as object)]))
      .filter(key => JSON.stringify((before as Record<string, unknown> | null)?.[key]) !== JSON.stringify((after as Record<string, unknown> | null)?.[key]));
    const details = entity === 'settings' ? { changedFields, before, after } : { changedFields };
    await appendAudit(client, actorId, action, entity, entityId, details);
  },
}), logging?: { stream: { write(message: string): void } }) {
  const app = Fastify({
    bodyLimit: 32 * 1024, trustProxy: (_address, hop) => hop < 1, logController: new LogController({ disableRequestLogging: true }),
    logger: { level: 'info', ...(logging?.stream ? { stream: logging.stream } : {}) },
  });
  app.addHook('onResponse', (request, reply, done) => {
    app.log.info({
      requestId: request.id, method: request.method, route: request.routeOptions.url ?? '<unmatched>',
      statusCode: reply.statusCode, durationMs: reply.elapsedTime,
    }, 'request completed');
    done();
  });
  registerAuthRoutes(app, pool);
  const guard = requireStaff(pool);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof SubmissionRejectedError) return reply.code(422).send({ code: error.reason, message: error.message });
    if (error instanceof ScheduleConflictError) return reply.code(409).send({ code: 'schedule_conflict', message: error.message, conflicts: error.conflicts });
    if (error instanceof RevisionConflictError) return reply.code(409).send({ code: 'revision_conflict', message: error.message });
    if (error instanceof IdempotencyConflictError) return reply.code(409).send({ code: 'idempotency_conflict', message: error.message });
    if (error instanceof NotFoundError) return reply.code(404).send({ code: 'not_found', message: error.message });
    if (error instanceof DataValidationError) return reply.code(422).send({ code: 'invalid', message: error.message });
    if (error && typeof error === 'object' && ('validation' in error || ('statusCode' in error && error.statusCode === 400))) return reply.code(400).send({ code: 'invalid', message: 'Проверьте данные запроса' });
    app.log.error({
      requestId: request.id, method: request.method, route: request.routeOptions.url ?? '<unmatched>',
      statusCode: 500, error: safeError(error),
    }, 'server error');
    return reply.code(500).send({ code: 'server_error', message: 'Не удалось выполнить запрос' });
  });

  app.get('/api/healthz', async () => ({ status: 'ok' }));
  app.get('/api/readyz', async () => { await pool.query('SELECT 1'); return { status: 'ok' }; });
  app.get('/api/services', async () => data.listServices());
  app.get('/api/schedule', async () => data.getSchedule());
  app.get<{ Querystring: { serviceId?: string; month?: string } }>('/api/availability', async request => {
    const { serviceId, month } = request.query;
    if (!serviceId || !month || !/^\d{4}-\d{2}$/.test(month)) throw new DataValidationError('Проверьте услугу и месяц');
    return data.getAvailability(serviceId, month);
  });

  const publicAttempts = new Map<string, { keys: Map<string, number>; times: number[]; lastSeen: number }>();
  let lastPrune = 0;
  app.post<{ Body: BookingDraft }>('/api/bookings', async (request, reply) => {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !key || key.length > 200) throw new DataValidationError('Требуется ключ отправки');
    const now = Date.now();
    if (now - lastPrune >= 60000) {
      for (const [ip, item] of publicAttempts) if (now - item.lastSeen >= 60000) publicAttempts.delete(ip);
      lastPrune = now;
    }
    const bucket = publicAttempts.get(request.ip) ?? { keys: new Map<string, number>(), times: [], lastSeen: now };
    bucket.times = bucket.times.filter(time => now - time < 60000);
    for (const [seenKey, seenAt] of bucket.keys) if (now - seenAt >= 60000) bucket.keys.delete(seenKey);
    if (!bucket.keys.has(key) && bucket.times.length >= 10) return reply.code(429).send({ code: 'rate_limited', message: 'Слишком много заявок. Попробуйте позже.' });
    if (!bucket.keys.has(key)) bucket.times.push(now);
    bucket.keys.set(key, now);
    bucket.lastSeen = now;
    publicAttempts.set(request.ip, bucket);
    const result = await data.submit(request.body, key);
    return reply.code(201).send(result);
  });

  app.get('/api/admin/snapshot', { preHandler: guard }, async () => data.getAdminSnapshot({ from: new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()) }));
  app.get<{ Querystring: { from?: string; to?: string; status?: AdminBooking['status']; cursor?: string; limit?: string } }>('/api/admin/bookings', { preHandler: guard }, async request => {
    const { from, to, status, cursor, limit } = request.query;
    return data.listAdminBookings({ from, to, status }, limit === undefined ? 50 : Number(limit), cursor);
  });
  app.get<{ Querystring: { actorId?: string; entity?: string; beforeId?: string; limit?: string } }>('/api/admin/audit', { preHandler: guard }, async request => {
    const { actorId, entity, beforeId, limit } = request.query;
    return listAudit(pool, { actorId, entity, beforeId: beforeId ? Number(beforeId) : undefined, limit: limit ? Number(limit) : undefined });
  });
  app.post<{ Body: { input: BookingInput } }>('/api/admin/bookings/preview', { preHandler: guard }, async request => data.previewBooking(request.body.input));
  app.post<{ Body: SaveBody<BookingInput> }>('/api/admin/bookings/save', { preHandler: guard }, async request => data.saveBooking(request.body.input, request.body.allowConflicts, request.staff!.id));
  app.delete<{ Params: IdParams; Querystring: { revision: string } }>('/api/admin/bookings/:id', { preHandler: guard }, async (request, reply) => {
    await data.deleteBooking(request.params.id, Number(request.query.revision), request.staff!.id);
    return reply.code(204).send();
  });
  app.post<{ Body: SaveBody<ServiceInput> }>('/api/admin/services/save', { preHandler: guard }, async request => data.saveService(request.body.input, request.body.allowConflicts, request.staff!.id));
  app.delete<{ Params: IdParams; Querystring: { revision: string } }>('/api/admin/services/:id', { preHandler: guard }, async (request, reply) => {
    await data.deleteService(request.params.id, Number(request.query.revision), request.staff!.id);
    return reply.code(204).send();
  });
  app.post<{ Params: IdParams; Body: { revision: number; archived: boolean } }>('/api/admin/services/:id/archive', { preHandler: guard }, async request => data.setServiceArchived(request.params.id, request.body.revision, request.body.archived, request.staff!.id));
  app.post<{ Body: SaveBody<CategoryInput> }>('/api/admin/categories/save', { preHandler: guard }, async request => data.saveCategory(request.body.input, request.body.allowConflicts, request.staff!.id));
  app.delete<{ Params: IdParams; Querystring: { revision: string } }>('/api/admin/categories/:id', { preHandler: guard }, async (request, reply) => {
    await data.deleteCategory(request.params.id, Number(request.query.revision), request.staff!.id);
    return reply.code(204).send();
  });
  app.post<{ Params: IdParams; Body: { revision: number; archived: boolean } }>('/api/admin/categories/:id/archive', { preHandler: guard }, async request => data.setCategoryArchived(request.params.id, request.body.revision, request.body.archived, request.staff!.id));
  app.post<{ Body: SaveBody<SettingsInput> }>('/api/admin/settings', { preHandler: guard }, async request => data.saveSettings(request.body.input, request.body.allowConflicts, request.staff!.id));
  return app;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString, max: 5 });
  const app = buildApp(pool);
  const shutdown = async () => { await app.close(); await pool.end(); };
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
  await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 3000) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(error => { console.error(JSON.stringify({ event: 'startup_error', error: safeError(error) })); process.exitCode = 1; });
}
