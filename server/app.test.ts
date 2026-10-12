import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { buildApp } from './app';
import type { createDataLayer } from './data';

describe('public API', () => {
  it('returns a saved overbooked booking as success with the existing frontend shape', async () => {
    const submit = vi.fn(async () => ({ status: 'overbooked', serviceName: 'Диагностика', date: '2026-11-01', time: '10:00' }));
    const layer = { submit } as unknown as ReturnType<typeof createDataLayer>;
    const app = buildApp({ query: vi.fn() } as unknown as Pool, layer);
    const draft = { serviceId: 's', date: '2026-11-01', time: '10:00', name: 'Иван', phone: '+79991234567', car: 'Лада', comment: '' };
    const response = await app.inject({ method: 'POST', url: '/api/bookings', headers: { 'idempotency-key': 'fixed-key' }, payload: draft });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ status: 'overbooked', serviceName: 'Диагностика' });
    expect(submit).toHaveBeenCalledWith(draft, 'fixed-key');
    await app.close();
  });

  it('limits distinct submissions per minute and lets an old key count as a new attempt later', async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const submit = vi.fn(async () => ({ status: 'confirmed', serviceName: 'Диагностика', date: '2026-11-01', time: '10:00' }));
    const app = buildApp({ query: vi.fn() } as unknown as Pool, { submit } as unknown as ReturnType<typeof createDataLayer>);
    const payload = { serviceId: 's', date: '2026-11-01', time: '10:00', name: 'Иван', phone: '+79991234567', car: 'Лада', comment: '' };
    try {
      for (let index = 0; index < 10; index++) expect((await app.inject({ method: 'POST', url: '/api/bookings', headers: { 'idempotency-key': `key-${index}` }, payload })).statusCode).toBe(201);
      expect((await app.inject({ method: 'POST', url: '/api/bookings', headers: { 'idempotency-key': 'key-0' }, payload })).statusCode).toBe(201);
      expect((await app.inject({ method: 'POST', url: '/api/bookings', headers: { 'idempotency-key': 'key-10' }, payload })).statusCode).toBe(429);
      now += 60000;
      expect((await app.inject({ method: 'POST', url: '/api/bookings', headers: { 'idempotency-key': 'key-0' }, payload })).statusCode).toBe(201);
    } finally { clock.mockRestore(); await app.close(); }
  });
});
