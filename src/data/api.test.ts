import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiProviders } from './api';
import { SubmissionRejectedError } from './demo';
import { emptyDraft } from '../domain/booking';

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
});
