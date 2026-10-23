import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { buildApp } from './app';
import { createStaff } from './auth';
import { createDataLayer } from './data';

const connectionString = process.env.INTEGRATION_TEST_DATABASE_URL;
const run = connectionString ? describe : describe.skip;

run('PostgreSQL integration', () => {
  const pool = new Pool({ connectionString });
  const data = createDataLayer(pool);
  const app = buildApp(pool);
  beforeAll(async () => {
    const parsed = new URL(connectionString!);
    if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) throw new Error('Integration database must be local');
    await pool.query('SELECT 1');
  });
  afterAll(async () => { await app.close(); await pool.end(); });

  it('serves the public API, persists conflicting requests once, and pages staff records', async () => {
    const category = await data.saveCategory({ name: 'Интеграция', lineCount: 1 });
    const service = await data.saveService({ name: 'Проверка API', categoryId: category.id, priceFrom: 100, durationMinutes: 60 });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const date = new Date(`${today}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + 1);
    const draft = { serviceId: service.id, date: date.toISOString().slice(0, 10), time: '03:00', name: 'Тест', phone: '89991234567', car: 'Авто', comment: '' };
    const firstKey = randomUUID(), secondKey = randomUUID();
    const first = await app.inject({ method: 'POST', url: '/api/bookings', headers: { 'idempotency-key': firstKey }, payload: draft });
    expect(first.statusCode).toBe(201);
    expect(first.json().status).toBe('overbooked');
    const replay = await app.inject({ method: 'POST', url: '/api/bookings', headers: { 'idempotency-key': firstKey }, payload: draft });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    const second = await app.inject({ method: 'POST', url: '/api/bookings', headers: { 'idempotency-key': secondKey }, payload: draft });
    expect(second.statusCode).toBe(201);
    expect(second.json().status).toBe('overbooked');
    const page = await data.listAdminBookings({ date: draft.date }, 1);
    expect(page.total).toBeGreaterThanOrEqual(2);
    expect(page.bookings).toHaveLength(1);
    expect(page.nextCursor).toBeTruthy();
    const next = await data.listAdminBookings({ date: draft.date }, 1, page.nextCursor!);
    expect(next.bookings).toHaveLength(1);
    expect(next.bookings[0].id).not.toBe(page.bookings[0].id);
    expect((await app.inject('/api/admin/snapshot')).statusCode).toBe(401);
  });

  it('keeps both requests when two clients submit the same initially free slot', async () => {
    const category = await data.saveCategory({ name: 'Параллельная запись', lineCount: 1 });
    const service = await data.saveService({ name: 'Одновременная заявка', categoryId: category.id, priceFrom: 100, durationMinutes: 60 });
    const month = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit' }).format(new Date());
    const availability = await data.getAvailability(service.id, month);
    const slot = availability.days.find(day => day.times.length) ?? (await data.getAvailability(service.id, availability.endDate.slice(0, 7))).days.find(day => day.times.length);
    expect(slot).toBeTruthy();
    const draft = { serviceId: service.id, date: slot!.date, time: slot!.times[0], name: 'Клиент', phone: '89991234567', car: 'Авто', comment: '' };
    const [first, second] = await Promise.all([randomUUID(), randomUUID()].map(key => app.inject({ method: 'POST', url: '/api/bookings', headers: { 'idempotency-key': key }, payload: draft })));
    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    expect([first.json().status, second.json().status].sort()).toEqual(['confirmed', 'overbooked']);
  });

  it('requires a staff session and CSRF token for admin changes and records the actor', async () => {
    const login = `test-${randomUUID().slice(0, 8)}`;
    await createStaff(pool, login, 'integration-pass-123');
    const signedIn = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login, password: 'integration-pass-123' } });
    expect(signedIn.statusCode).toBe(200);
    const cookie = String(signedIn.headers['set-cookie']).split(';')[0];
    const headers = { cookie, 'x-csrf-token': signedIn.json().csrfToken };
    expect((await app.inject({ method: 'GET', url: '/api/admin/snapshot', headers })).statusCode).toBe(200);
    const payload = { input: { name: 'Категория с автором', lineCount: 1 } };
    expect((await app.inject({ method: 'POST', url: '/api/admin/categories/save', headers: { cookie }, payload })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/admin/categories/save', headers, payload })).statusCode).toBe(200);
    const audit = await app.inject({ method: 'GET', url: '/api/admin/audit', headers });
    expect(audit.statusCode).toBe(200);
    expect(audit.json()).toEqual(expect.arrayContaining([expect.objectContaining({ actor_login: login, action: 'create', entity: 'category' })]));
  });
});
