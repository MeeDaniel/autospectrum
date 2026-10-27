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

  it('reports seconds until the earliest public attempt expires', async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const submit = vi.fn(async () => ({ status: 'confirmed' }));
    const app = buildApp({ query: vi.fn() } as unknown as Pool, { submit } as unknown as ReturnType<typeof createDataLayer>);
    const payload = { serviceId: 's', date: '2026-11-01', time: '10:00', name: 'Иван', phone: '+79991234567', car: 'Лада', comment: '' };
    const send = (key: string) => app.inject({ method: 'POST', url: '/api/bookings', headers: { 'idempotency-key': key }, payload });
    try {
      await send('key-0');
      now += 1_100;
      for (let index = 1; index < 10; index++) await send(`key-${index}`);
      const rejection = await send('key-10');
      expect(rejection.statusCode).toBe(429);
      expect(rejection.headers['retry-after']).toBe('59');
      expect(submit).toHaveBeenCalledTimes(10);
      now += 58_900;
      expect((await send('key-10')).statusCode).toBe(201);
    } finally { clock.mockRestore(); await app.close(); }
  });
});

describe('production request boundaries', () => {
  const draft = { serviceId: 's', date: '2026-11-01', time: '10:00', name: 'Иван', phone: '+79991234567', car: 'Лада', comment: '' };

  it('limits forwarded clients independently behind the same proxy', async () => {
    const submit = vi.fn(async () => ({ status: 'confirmed' }));
    const app = buildApp({ query: vi.fn() } as unknown as Pool, { submit } as unknown as ReturnType<typeof createDataLayer>);
    const send = (client: string, key: string) => app.inject({
      method: 'POST', url: '/api/bookings', remoteAddress: '172.20.0.3',
      headers: { 'x-forwarded-for': client, 'idempotency-key': key }, payload: draft,
    });
    try {
      for (let index = 0; index < 10; index++) expect((await send('198.51.100.10', `a-${index}`)).statusCode).toBe(201);
      expect((await send('198.51.100.10', 'a-10')).statusCode).toBe(429);
      expect((await send('198.51.100.11', 'b-0')).statusCode).toBe(201);
      for (let index = 1; index < 10; index++) expect((await send('198.51.100.11', `b-${index}`)).statusCode).toBe(201);
      expect((await send('198.51.100.11', 'b-10')).statusCode).toBe(429);
    } finally { await app.close(); }
  });

  it('logs the route template and response metrics without query values', async () => {
    const lines: string[] = [];
    const listServices = vi.fn(async () => []);
    const app = buildApp({ query: vi.fn() } as unknown as Pool,
      { listServices } as unknown as ReturnType<typeof createDataLayer>,
      { stream: { write: (line: string) => { lines.push(line); } } });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/services?search=QUERY_SECRET_987' });
      expect(response.statusCode).toBe(200);
      const events = lines.map(line => JSON.parse(line));
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({
        requestId: expect.any(String), method: 'GET', route: '/api/services', statusCode: 200,
        durationMs: expect.any(Number),
      })]));
      expect(lines.join('')).not.toContain('QUERY_SECRET_987');
    } finally { await app.close(); }
  });

  it('logs safe exception diagnostics without request or database secrets', async () => {
    const lines: string[] = [];
    const failure = Object.assign(new Error('password=ERROR_SECRET_987 sql parameters=SQL_SECRET_987'), { code: '23505' });
    const submit = vi.fn(async () => { throw failure; });
    const app = buildApp({ query: vi.fn() } as unknown as Pool,
      { submit } as unknown as ReturnType<typeof createDataLayer>,
      { stream: { write: (line: string) => { lines.push(line); } } });
    try {
      const response = await app.inject({
        method: 'POST', url: '/api/bookings?search=QUERY_SECRET_987',
        headers: { 'idempotency-key': 'key-1', cookie: 'session=COOKIE_SECRET_987', 'x-csrf-token': 'CSRF_SECRET_987' },
        payload: { ...draft, name: 'BODY_SECRET_987' },
      });
      expect(response.statusCode).toBe(500);
      const events = lines.map(line => JSON.parse(line));
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({
        requestId: expect.any(String), method: 'POST', route: '/api/bookings',
        statusCode: 500, error: expect.objectContaining({ name: 'Error', code: '23505', frames: expect.any(Array) }),
      })]));
      expect(events.find(event => event.error)?.error.frames.length).toBeGreaterThan(0);
      for (const secret of ['ERROR_SECRET_987', 'SQL_SECRET_987', 'QUERY_SECRET_987', 'COOKIE_SECRET_987', 'CSRF_SECRET_987', 'BODY_SECRET_987']) {
        expect(lines.join('')).not.toContain(secret);
      }
    } finally { await app.close(); }
  });
});

describe('trusted proxy boundary', () => {
  it('counts the rightmost forwarded client when a direct request supplies a forged chain', async () => {
    const submit = vi.fn(async () => ({ status: 'confirmed' }));
    const app = buildApp({ query: vi.fn() } as unknown as Pool, { submit } as unknown as ReturnType<typeof createDataLayer>);
    const draft = { serviceId: 's', date: '2026-11-01', time: '10:00', name: 'Иван', phone: '+79991234567', car: 'Лада', comment: '' };
    const send = (chain: string, key: string) => app.inject({
      method: 'POST', url: '/api/bookings', remoteAddress: '172.20.0.3',
      headers: { 'x-forwarded-for': chain, 'idempotency-key': key }, payload: draft,
    });
    try {
      for (let index = 0; index < 10; index++) expect((await send('203.0.113.99, 198.51.100.10', `forged-${index}`)).statusCode).toBe(201);
      expect((await send('198.51.100.10', 'same-rightmost-client')).statusCode).toBe(429);
      expect((await send('203.0.113.99', 'forged-leftmost-client')).statusCode).toBe(201);
    } finally { await app.close(); }
  });
});
