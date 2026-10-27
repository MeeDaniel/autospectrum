import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { createDataLayer } from './data';
import { buildApp } from './app';
import { createStaff } from './staff-management';
import type { AdminBooking, AdminCategory, AdminService } from '../src/domain/admin';

const connectionString = process.env.INTEGRATION_TEST_DATABASE_URL;
const run = connectionString ? describe : describe.skip;

run('whole-dataset booking filters', () => {
  const pool = new Pool({ connectionString });
  const data = createDataLayer(pool);
  const app = buildApp(pool);
  const prefix = `filters-${randomUUID()}`;
  const login = `filters-${randomUUID().slice(0, 12)}`;
  let staffId = '';
  const categories: AdminCategory[] = [
    { id: `${prefix}-a`, name: 'A', lineCount: 2, archived: false, revision: 1 },
    { id: `${prefix}-b`, name: 'B', lineCount: 2, archived: false, revision: 1 },
  ];
  const services: AdminService[] = [
    { id: `${prefix}-a1`, categoryId: categories[0].id, name: 'A1', priceFrom: 100, durationMinutes: 30, archived: false, revision: 1 },
    { id: `${prefix}-a2`, categoryId: categories[0].id, name: 'A2', priceFrom: 100, durationMinutes: 30, archived: false, revision: 1 },
    { id: `${prefix}-b1`, categoryId: categories[1].id, name: 'B1', priceFrom: 100, durationMinutes: 30, archived: false, revision: 1 },
  ];
  const booking = (index: number, overrides: Partial<AdminBooking> = {}): AdminBooking => ({
    id: `${prefix}-${String(index).padStart(3, '0')}`, serviceId: services[0].id,
    date: '2026-10-20', startMinute: 600, durationMinutes: 30,
    name: 'Other', phone: '+79990000000', car: 'Car', comment: '', status: 'new', revision: 1,
    ...overrides,
  });
  const rows = Array.from({ length: 110 }, (_, index) => booking(index));
  rows.push(
    booking(110, { name: ' Needle ', serviceId: services[0].id, date: '2026-10-19', status: 'confirmed' }),
    booking(111, { phone: '+7999Needle', serviceId: services[1].id, date: '2026-10-19', status: 'confirmed' }),
    booking(112, { car: 'Needle', serviceId: services[2].id, date: '2026-10-19', status: 'confirmed' }),
    booking(113, { name: 'needle', serviceId: services[0].id, date: '2026-10-18', status: 'cancelled' }),
    booking(114, { name: '100% Service', serviceId: services[0].id }),
    booking(115, { car: 'A_B', serviceId: services[0].id }),
  );

  beforeAll(async () => {
    const parsed = new URL(connectionString!);
    if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || !parsed.pathname.endsWith('/autospectrum_filters_test')) throw new Error('Use the isolated filters database');
    await pool.query("DELETE FROM audit_log WHERE actor_id IN (SELECT id FROM staff_users WHERE login LIKE 'filters-%') OR (entity = 'staff' AND entity_id IN (SELECT id::text FROM staff_users WHERE login LIKE 'filters-%'))");
    await pool.query("DELETE FROM staff_sessions WHERE staff_id IN (SELECT id FROM staff_users WHERE login LIKE 'filters-%')");
    await pool.query("DELETE FROM staff_users WHERE login LIKE 'filters-%'");
    await pool.query("DELETE FROM bookings WHERE id LIKE 'filters-%'");
    await pool.query("DELETE FROM services WHERE id LIKE 'filters-%'");
    await pool.query("DELETE FROM categories WHERE id LIKE 'filters-%'");
    for (const category of categories) await pool.query('INSERT INTO categories (id, data) VALUES ($1, $2::jsonb)', [category.id, JSON.stringify(category)]);
    for (const service of services) await pool.query('INSERT INTO services (id, category_id, data) VALUES ($1, $2, $3::jsonb)', [service.id, service.categoryId, JSON.stringify(service)]);
    for (const row of rows) await pool.query('INSERT INTO bookings (id, service_id, date, status, data) VALUES ($1, $2, $3, $4, $5::jsonb)', [row.id, row.serviceId, row.date, row.status, JSON.stringify(row)]);
    staffId = (await createStaff(pool, login, 'filters-test-password', 'operator')).id;
  });
  afterAll(async () => {
    await app.close();
    if (staffId) {
      await pool.query('DELETE FROM audit_log WHERE actor_id = $1 OR (entity = $2 AND entity_id = $3)', [staffId, 'staff', staffId]);
      await pool.query('DELETE FROM staff_sessions WHERE staff_id = $1', [staffId]);
      await pool.query('DELETE FROM staff_users WHERE id = $1', [staffId]);
    }
    await pool.query('DELETE FROM bookings WHERE id LIKE $1', [`${prefix}-%`]);
    await pool.query('DELETE FROM services WHERE id LIKE $1', [`${prefix}-%`]);
    await pool.query('DELETE FROM categories WHERE id LIKE $1', [`${prefix}-%`]);
    await pool.end();
  });

  it('finds name, phone and car matches beyond the first 50 rows with a filtered total', async () => {
    const result = await data.listAdminBookings({ query: '  nEeDlE  ' }, 50);
    expect(result.total).toBe(4);
    expect(result.bookings.map(item => item.id)).toEqual([rows[112].id, rows[111].id, rows[110].id, rows[113].id]);
  });

  it('intersects category, service, dates and status before count and limit', async () => {
    const result = await data.listAdminBookings({ query: 'needle', categoryId: categories[0].id, serviceId: services[0].id, from: '2026-10-19', to: '2026-10-19', status: 'confirmed' }, 1);
    expect(result.total).toBe(1);
    expect(result.bookings.map(item => item.id)).toEqual([rows[110].id]);
    expect(result.nextCursor).toBeNull();
  });

  it('treats percent and underscore as literal query characters', async () => {
    expect((await data.listAdminBookings({ query: '%' })).bookings.map(item => item.id)).toEqual([rows[114].id]);
    expect((await data.listAdminBookings({ query: '_' })).bookings.map(item => item.id)).toEqual([rows[115].id]);
  });

  it('pages a filtered set in descending date, time and id without omission or duplication', async () => {
    const expected = [rows[112].id, rows[111].id, rows[110].id, rows[113].id];
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await data.listAdminBookings({ query: 'needle' }, 2, cursor);
      expect(page.total).toBe(4);
      seen.push(...page.bookings.map(item => item.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(expected);
  });

  it('passes query and catalog filters through the authenticated HTTP endpoint', async () => {
    const signedIn = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login, password: 'filters-test-password' } });
    expect(signedIn.statusCode).toBe(200);
    const cookie = String(signedIn.headers['set-cookie']).split(';')[0];
    const params = new URLSearchParams({ query: '  nEeDlE  ', categoryId: categories[0].id, serviceId: services[0].id, from: '2026-10-19', to: '2026-10-19', status: 'confirmed' });
    const response = await app.inject({ method: 'GET', url: `/api/admin/bookings?${params}`, headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ total: 1, bookings: [{ id: rows[110].id }], nextCursor: null });
  });
});
