import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createDataLayer } from './data';

const connectionString = process.env.INTEGRATION_TEST_DATABASE_URL;
const run = connectionString ? describe : describe.skip;

run('public booking window in PostgreSQL', () => {
  const pool = new Pool({ connectionString });
  const data = createDataLayer(pool, { now: () => new Date('2026-10-27T12:00:00Z') });
  const prefix = `window-${randomUUID()}`;
  const categoryId = `${prefix}-category`;
  const serviceId = `${prefix}-service`;
  const keys = ['today', 'tomorrow', 'day-60', 'day-61'].map(label => `${prefix}-${label}`);

  beforeAll(async () => {
    const parsed = new URL(connectionString!);
    if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || parsed.pathname !== '/autospectrum_window_test') {
      throw new Error('Use the isolated autospectrum_window_test database');
    }
    const category = { id: categoryId, name: 'Window test', lineCount: 1, archived: false, revision: 1 };
    const service = { id: serviceId, categoryId, name: 'Window service', priceFrom: 100, durationMinutes: 30, archived: false, revision: 1 };
    await pool.query('INSERT INTO categories (id, data) VALUES ($1, $2::jsonb)', [categoryId, JSON.stringify(category)]);
    await pool.query('INSERT INTO services (id, category_id, data) VALUES ($1, $2, $3::jsonb)', [serviceId, categoryId, JSON.stringify(service)]);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM idempotency_keys WHERE key = ANY($1::text[])', [keys]);
    await pool.query('DELETE FROM bookings WHERE service_id = $1', [serviceId]);
    await pool.query('DELETE FROM services WHERE id = $1', [serviceId]);
    await pool.query('DELETE FROM categories WHERE id = $1', [categoryId]);
    await pool.end();
  });

  it('offers and persists tomorrow and day 60 while rejecting today and day 61', async () => {
    const october = await data.getAvailability(serviceId, '2026-10');
    const december = await data.getAvailability(serviceId, '2026-12');
    expect(october.startDate).toBe('2026-10-28');
    expect(december.endDate).toBe('2026-12-26');
    expect(october.days.some(day => day.date === '2026-10-27')).toBe(false);
    expect(october.days.find(day => day.date === '2026-10-28')?.times).toContain('10:00');
    expect(december.days.find(day => day.date === '2026-12-26')?.times).toContain('10:00');
    expect(december.days.some(day => day.date === '2026-12-27')).toBe(false);

    const draft = { serviceId, date: '', time: '10:00', name: 'Window client', phone: '9999999998', car: 'Car', comment: '' };
    await expect(data.submit({ ...draft, date: '2026-10-27' }, keys[0])).rejects.toMatchObject({ reason: 'unavailable' });
    expect((await data.submit({ ...draft, date: '2026-10-28' }, keys[1])).status).toBe('confirmed');
    expect((await data.submit({ ...draft, date: '2026-12-26' }, keys[2])).status).toBe('confirmed');
    await expect(data.submit({ ...draft, date: '2026-12-27' }, keys[3])).rejects.toMatchObject({ reason: 'unavailable' });

    const saved = await pool.query('SELECT date::text AS date FROM bookings WHERE service_id = $1 ORDER BY date', [serviceId]);
    expect(saved.rows.map(row => row.date)).toEqual(['2026-10-28', '2026-12-26']);
  });
});
