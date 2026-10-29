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
  it('filters the complete demo dataset before counting and paging', async () => {
    const store = new MemoryDemoStore();
    await store.update(snapshot => {
      snapshot.categories.push({ id: 'other-category', name: 'Other', lineCount: 2, archived: false, revision: 1 });
      snapshot.services.push({ id: 'other-service', categoryId: 'other-category', name: 'Other', priceFrom: 100, durationMinutes: 30, archived: false, revision: 1 });
      for (let index = 0; index < 110; index++) snapshot.bookings.push({ id: `other-${index}`, serviceId: 'diagnostics', date: '2026-10-20', startMinute: 600, durationMinutes: 30, name: 'Other', phone: '+79990000000', car: 'Car', comment: '', status: 'new', revision: 1 });
      snapshot.bookings.push({ id: 'target-one', serviceId: 'diagnostics', date: '2026-10-19', startMinute: 600, durationMinutes: 30, name: 'Needle %', phone: '+79990000000', car: 'Car', comment: '', status: 'confirmed', revision: 1 });
      snapshot.bookings.push({ id: 'target-two', serviceId: 'other-service', date: '2026-10-19', startMinute: 600, durationMinutes: 30, name: 'Other', phone: '+7999Needle', car: 'Car_', comment: '', status: 'confirmed', revision: 1 });
    });
    const { adminProvider } = createDemoProviders(store);
    const first = await adminProvider.listBookings({ query: '  nEeDlE  ' }, 1);
    expect(first.total).toBe(2);
    expect(first.bookings.map(item => item.id)).toEqual(['target-two']);
    const second = await adminProvider.listBookings({ query: 'needle' }, 1, first.nextCursor!);
    expect(second.bookings.map(item => item.id)).toEqual(['target-one']);
    expect(second.nextCursor).toBeNull();
    const intersection = await adminProvider.listBookings({ query: '%', categoryId: 'general', serviceId: 'diagnostics', from: '2026-10-19', to: '2026-10-19', status: 'confirmed' });
    expect(intersection.total).toBe(1);
    expect(intersection.bookings.map(item => item.id)).toEqual(['target-one']);
    expect((await adminProvider.listBookings({ query: '_' })).bookings.map(item => item.id)).toEqual(['target-two']);
  });

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

  it('uses the same Moscow tomorrow-through-day-60 window for availability and submission', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-27T20:59:59Z'));
    const { provider, adminProvider } = createDemoProviders(new MemoryDemoStore());
    const october = await provider.getAvailability('diagnostics', '2026-10');
    const december = await provider.getAvailability('diagnostics', '2026-12');
    expect(october.startDate).toBe('2026-10-28');
    expect(december.endDate).toBe('2026-12-26');
    expect(october.days.some(day => day.date === '2026-10-27')).toBe(false);
    expect(october.days.find(day => day.date === '2026-10-28')?.times).toContain('10:00');
    expect(december.days.find(day => day.date === '2026-12-26')?.times).toContain('10:00');
    expect(december.days.some(day => day.date === '2026-12-27')).toBe(false);

    await expect(provider.submit({ ...draft, date: '2026-10-27' })).rejects.toMatchObject({ reason: 'unavailable' });
    expect((await provider.submit({ ...draft, date: '2026-10-28' })).status).toBe('confirmed');
    expect((await provider.submit({ ...draft, date: '2026-12-26' })).status).toBe('confirmed');
    await expect(provider.submit({ ...draft, date: '2026-12-27' })).rejects.toMatchObject({ reason: 'unavailable' });
    expect((await adminProvider.getSnapshot()).bookings.map(booking => booking.date)).toEqual(['2026-10-28', '2026-12-26']);

    vi.setSystemTime(new Date('2026-10-27T21:00:00Z'));
    expect((await provider.getAvailability('diagnostics', '2026-10')).startDate).toBe('2026-10-29');
    await expect(provider.submit({ ...draft, date: '2026-10-28' })).rejects.toMatchObject({ reason: 'unavailable' });
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
