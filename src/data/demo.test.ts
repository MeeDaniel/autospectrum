import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoProviders, MemoryDemoStore, RevisionConflictError, ScheduleConflictError, SubmissionRejectedError } from './demo';

const tomorrow = (() => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const value = (type: string) => parts.find(part => part.type === type)!.value;
  const date = new Date(`${value('year')}-${value('month')}-${value('day')}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
})();
const draft = { serviceId: 'diagnostics', date: tomorrow, time: '10:00', name: 'Иван', phone: '+79991234567', car: 'Лада', comment: '' };

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('shared demo providers', () => {
  it('persists a public submission for the operator without returning its ID', async () => {
    const { provider, adminProvider } = createDemoProviders(new MemoryDemoStore());
    const result = await provider.submit(draft);
    expect(result).toEqual({ status: 'confirmed', serviceName: 'Диагностика', date: draft.date, time: draft.time });
    const bookings = (await adminProvider.getSnapshot()).bookings;
    expect(bookings).toHaveLength(1);
    expect(bookings[0]).toMatchObject({ serviceId: 'diagnostics', date: draft.date, startMinute: 600, durationMinutes: 30, status: 'new' });
    expect(bookings[0].id).toBeTruthy();
  });

  it('uses capacity, breaks and lines for public availability', async () => {
    const { provider, adminProvider } = createDemoProviders(new MemoryDemoStore());
    const category = (await adminProvider.getSnapshot()).categories[0];
    await adminProvider.saveCategory({ ...category, lineCount: 1 });
    await provider.submit(draft);
    const availability = await provider.getAvailability('diagnostics', draft.date.slice(0, 7));
    expect(availability.days.find(day => day.date === draft.date)?.times).not.toContain('10:00');
    expect(availability.days.find(day => day.date === draft.date)?.times).not.toContain('12:00');
    expect(availability.days.find(day => day.date === draft.date)?.times).toContain('10:30');
  });

  it('saves a booking selected before a competing booking as an overbooked new request', async () => {
    const { provider, adminProvider } = createDemoProviders(new MemoryDemoStore());
    const category = (await adminProvider.getSnapshot()).categories[0];
    await adminProvider.saveCategory({ ...category, lineCount: 1 });
    await provider.submit(draft);
    expect((await provider.submit(draft)).status).toBe('overbooked');
    expect((await adminProvider.getSnapshot()).bookings).toHaveLength(2);
  });

  it('requires explicit conflict confirmation and prevents stale overwrites', async () => {
    const { adminProvider } = createDemoProviders(new MemoryDemoStore());
    const one = await adminProvider.saveBooking({ serviceId: draft.serviceId, date: draft.date, startMinute: 600, durationMinutes: 30, name: draft.name, phone: draft.phone, car: draft.car, comment: draft.comment, status: 'new' });
    const two = { ...one, id: undefined, revision: undefined, startMinute: 600 };
    const category = (await adminProvider.getSnapshot()).categories[0];
    await adminProvider.saveCategory({ ...category, lineCount: 1 }, true);
    await expect(adminProvider.saveBooking(two)).rejects.toBeInstanceOf(ScheduleConflictError);
    const saved = await adminProvider.saveBooking(two, true);
    expect(saved.id).not.toBe(one.id);
    await adminProvider.saveBooking({ ...one, car: 'Новая Лада' }, true);
    await expect(adminProvider.saveBooking({ ...one, car: 'Старая Лада' }, true)).rejects.toBeInstanceOf(RevisionConflictError);
  });

  it('archives referenced service and keeps existing booking while removing new selection', async () => {
    const { provider, adminProvider } = createDemoProviders(new MemoryDemoStore());
    await provider.submit(draft);
    const service = (await adminProvider.getSnapshot()).services.find(item => item.id === 'diagnostics')!;
    await adminProvider.setServiceArchived(service.id, service.revision, true);
    expect((await provider.listServices()).some(item => item.id === service.id)).toBe(false);
    expect((await adminProvider.getSnapshot()).bookings).toHaveLength(1);
    await expect(provider.submit(draft)).rejects.toBeInstanceOf(SubmissionRejectedError);
  });

  it('exposes updated working hours to the public view without admin IDs', async () => {
    const { provider, adminProvider } = createDemoProviders(new MemoryDemoStore());
    const settings = (await adminProvider.getSnapshot()).settings;
    await adminProvider.saveSettings({ ...settings, workStart: 600, workEnd: 1020, breaks: [] });
    expect(await provider.getSchedule()).toEqual({ workStart: 600, workEnd: 1020 });
  });

  it('excludes elapsed slots today and rejects a stale selected time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T07:15:00Z')); // 10:15 Moscow
    const { provider } = createDemoProviders(new MemoryDemoStore());
    const availability = await provider.getAvailability('diagnostics', '2026-10');
    const today = availability.startDate;
    expect(availability.days.find(day => day.date === today)?.times).not.toContain('10:00');
    expect(availability.days.find(day => day.date === today)?.times).toContain('10:30');
    await expect(provider.submit({ ...draft, date: today, time: '10:00' })).rejects.toBeInstanceOf(SubmissionRejectedError);
  });

  it('stores a new booking when structuredClone and randomUUID are unavailable', async () => {
    vi.stubGlobal('structuredClone', undefined);
    const nativeCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: nativeCrypto.getRandomValues.bind(nativeCrypto) });
    const { provider, adminProvider } = createDemoProviders(new MemoryDemoStore());
    await provider.submit(draft);
    expect((await adminProvider.getSnapshot()).bookings[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('allows editing a service while its existing category is archived', async () => {
    const { adminProvider } = createDemoProviders(new MemoryDemoStore());
    const snapshot = await adminProvider.getSnapshot();
    const category = snapshot.categories[0];
    const service = snapshot.services.find(item => item.id === 'diagnostics')!;
    await adminProvider.setCategoryArchived(category.id, category.revision, true);
    const saved = await adminProvider.saveService({ ...service, name: 'Новая диагностика' });
    expect(saved.name).toBe('Новая диагностика');
    expect(saved.categoryId).toBe(category.id);
  });
});
