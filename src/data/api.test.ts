import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiProviders } from './api';
import { SubmissionRejectedError } from './demo';
import { emptyDraft } from '../domain/booking';
import { RateLimitError } from './rate-limit';

const draft = { ...emptyDraft, serviceId: 's', date: '2026-11-01', time: '10:00', name: 'Иван', phone: '+79991234567', car: 'Лада' };

afterEach(() => vi.unstubAllGlobals());

describe('HTTP booking provider', () => {
  it('reuses the idempotency key only for an unchanged submission', async () => {
    const keys: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
      keys.push(new Headers(options.headers).get('Idempotency-Key') ?? '');
      return new Response(JSON.stringify({ status: 'confirmed', serviceName: 'Диагностика', date: draft.date, time: draft.time }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }));
    const { provider } = createApiProviders();
    await provider.submit(draft);
    await provider.submit(draft);
    await provider.submit({ ...draft, time: '10:30' });
    expect(keys[0]).toBeTruthy();
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('maps a definitive unavailable response to the existing form error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'unavailable' }), { status: 422, headers: { 'Content-Type': 'application/json' } })));
    const { provider } = createApiProviders();
    await expect(provider.submit(draft)).rejects.toMatchObject({ name: 'SubmissionRejectedError', reason: 'unavailable' } satisfies Partial<SubmissionRejectedError>);
  });

  it.each([
    ['27', 27],
    ['0', 60],
    ['invalid', 60],
    [null, 60],
  ])('maps booking 429 Retry-After %s to a definitive wait of %i seconds', async (header, seconds) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'rate_limited' }), {
      status: 429, headers: header === null ? {} : { 'Retry-After': header },
    })));
    const { provider } = createApiProviders();
    await expect(provider.submit(draft)).rejects.toEqual(new RateLimitError(seconds));
  });
});

describe('admin API session', () => {
  it('keeps an admin login 429 as its own authentication error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'rate_limited', message: 'Слишком много попыток входа' }), {
      status: 429, headers: { 'Retry-After': '12' },
    })));
    const { auth } = createApiProviders();
    await expect(auth.login('desk', 'wrong')).rejects.toThrow('Слишком много попыток входа');
  });

  it('sends every booking filter through the list endpoint', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ bookings: [], total: 0, nextCursor: null, conflicts: {} }), { status: 200 });
    }));
    const { adminProvider } = createApiProviders();
    await adminProvider.listBookings({ query: '  Иван %_  ', categoryId: 'cat', serviceId: 'svc', from: '2026-10-01', to: '2026-10-31', status: 'confirmed' }, 25, 'next');
    const url = new URL(urls[0], 'http://localhost');
    expect(url.pathname).toBe('/api/admin/bookings');
    expect(Object.fromEntries(url.searchParams)).toEqual({ limit: '25', from: '2026-10-01', to: '2026-10-31', status: 'confirmed', query: '  Иван %_  ', categoryId: 'cat', serviceId: 'svc', cursor: 'next' });
  });

  it('clears cached CSRF and signals login after a protected request returns 401', async () => {
    const calls: { url: string; csrf: string | null }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      calls.push({ url, csrf: new Headers(options.headers).get('X-CSRF-Token') });
      if (url === '/api/admin/login') return new Response(JSON.stringify({ staff: { id: 'operator-1', login: 'desk', role: 'operator' }, csrfToken: 'csrf-old' }), { status: 200 });
      if (url === '/api/admin/staff') return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
      if (url === '/api/admin/me') return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
      return new Response('{}', { status: 200 });
    }));
    const { auth, staffManagement } = createApiProviders();
    await auth.login('desk', 'password');
    let expired = 0;
    auth.onUnauthorized(() => { expired++; });
    await expect(staffManagement.create({ login: 'newstaff', password: 'a long password', role: 'staff' })).rejects.toThrow();
    expect(expired).toBe(1);
    expect(calls.find(call => call.url === '/api/admin/staff')?.csrf).toBe('csrf-old');
    await expect(staffManagement.create({ login: 'newstaff', password: 'a long password', role: 'staff' })).rejects.toThrow();
    expect(calls.find(call => call.url === '/api/admin/me')?.csrf).toBeNull();
  });
});
