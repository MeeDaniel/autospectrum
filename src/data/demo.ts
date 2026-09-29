import type { Availability, BookingDraft, Service, SubmissionResult } from '../domain/booking';
import { normalizePhone, validateDraft } from '../domain/booking';
import { assessBooking, formatMinute, parseMinute, validDate, validMinute, validateSettings } from '../domain/admin';
import type { AdminBooking, AdminCategory, AdminService, AdminSettings, AdminSnapshot, BookingInput, CategoryInput, Conflict, ServiceInput, SettingsInput } from '../domain/admin';
import { copyDemoValue, IndexedDbDemoStore, type DemoStore } from './store';

export { MemoryDemoStore, IndexedDbDemoStore } from './store';
export type { DemoStore } from './store';

export interface BookingProvider {
  listServices(): Promise<Service[]>;
  getSchedule(): Promise<{ workStart: number; workEnd: number }>;
  getAvailability(serviceId: string, month: string): Promise<Availability>;
  submit(draft: BookingDraft): Promise<SubmissionResult>;
}

export interface AdminProvider {
  getSnapshot(): Promise<AdminSnapshot>;
  previewBooking(input: BookingInput): Promise<Conflict[]>;
  saveBooking(input: BookingInput, allowConflicts?: boolean): Promise<AdminBooking>;
  deleteBooking(id: string, revision: number): Promise<void>;
  saveService(input: ServiceInput, allowConflicts?: boolean): Promise<AdminService>;
  deleteService(id: string, revision: number): Promise<void>;
  setServiceArchived(id: string, revision: number, archived: boolean): Promise<AdminService>;
  saveCategory(input: CategoryInput, allowConflicts?: boolean): Promise<AdminCategory>;
  deleteCategory(id: string, revision: number): Promise<void>;
  setCategoryArchived(id: string, revision: number, archived: boolean): Promise<AdminCategory>;
  saveSettings(input: SettingsInput, allowConflicts?: boolean): Promise<AdminSettings>;
  subscribe(listener: () => void): () => void;
}

export class SubmissionRejectedError extends Error {
  constructor(public readonly reason: 'invalid' | 'unavailable') {
    super(reason === 'unavailable' ? 'Время недоступно' : 'Проверьте данные заявки');
    this.name = 'SubmissionRejectedError';
  }
}
export class RevisionConflictError extends Error {
  constructor() { super('Данные изменились в другой вкладке. Загрузите актуальную версию.'); this.name = 'RevisionConflictError'; }
}
export class ScheduleConflictError extends Error {
  constructor(public readonly conflicts: Conflict[]) { super('Есть конфликты расписания'); this.name = 'ScheduleConflictError'; }
}

const timezone = 'Europe/Moscow';
function id(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function todayInMoscow(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const value = (type: string) => parts.find(part => part.type === type)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
function minuteInMoscow(now = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const value = (type: string) => Number(parts.find(part => part.type === type)!.value);
  return value('hour') * 60 + value('minute');
}
function addDays(date: string, days: number): string {
  const utc = new Date(`${date}T12:00:00Z`);
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
}
function required(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function revisionOf<T extends { id: string; revision: number }>(items: T[], itemId: string, revision?: number): T {
  const item = items.find(value => value.id === itemId);
  if (!item) throw new Error('Запись не найдена');
  if (item.revision !== revision) throw new RevisionConflictError();
  return item;
}
function assertBooking(input: BookingInput): void {
  required(validDate(input.date) && validMinute(input.startMinute) && Number.isInteger(input.durationMinutes) && input.durationMinutes > 0 && input.startMinute + input.durationMinutes <= 1439, 'Проверьте дату, время и длительность');
  required(input.name.trim() && input.car.trim() && /^\+7\d{10}$/.test(normalizePhone(input.phone)), 'Проверьте данные клиента');
  required(['new', 'confirmed', 'in_progress', 'completed', 'cancelled'].includes(input.status), 'Некорректный статус');
}
function assertService(input: ServiceInput, snapshot: AdminSnapshot, existing?: AdminService): void {
  required(input.name.trim() && Number.isFinite(input.priceFrom) && input.priceFrom >= 0 && Number.isInteger(input.durationMinutes) && input.durationMinutes > 0 && input.durationMinutes <= 1439, 'Проверьте услугу');
  required(snapshot.categories.some(category => category.id === input.categoryId && (!category.archived || existing?.categoryId === category.id)), 'Выберите действующую категорию');
}
function assertCategory(input: CategoryInput): void {
  required(input.name.trim() && Number.isInteger(input.lineCount) && input.lineCount >= 0, 'Проверьте категорию');
}
function impact(before: AdminSnapshot, after: AdminSnapshot): Conflict[] {
  const old = new Map(before.bookings.map(booking => [booking.id, assessBooking(booking, before)]));
  return after.bookings.flatMap(booking => {
    const previous = old.get(booking.id) ?? [];
    return assessBooking(booking, after).filter(conflict => !previous.some(item => item.kind === conflict.kind && item.start === conflict.start && item.end === conflict.end && item.bookingIds.join(',') === conflict.bookingIds.join(',')));
  });
}
function throwOnImpact(before: AdminSnapshot, after: AdminSnapshot, allow: boolean): void {
  const conflicts = impact(before, after);
  if (conflicts.length && !allow) throw new ScheduleConflictError(conflicts);
}

export function createDemoProviders(store: DemoStore): { provider: BookingProvider; adminProvider: AdminProvider } {
  const adminProvider: AdminProvider = {
    getSnapshot: () => store.read(),
    async previewBooking(input) {
      assertBooking(input);
      return assessBooking(input, await store.read());
    },
    saveBooking(input, allowConflicts = false) {
      return store.update(snapshot => {
        assertBooking(input);
        const existing = input.id ? revisionOf(snapshot.bookings, input.id, input.revision) : undefined;
        const service = snapshot.services.find(item => item.id === input.serviceId);
        required(service && (!service.archived || existing?.serviceId === service.id), 'Услуга недоступна');
        const category = snapshot.categories.find(item => item.id === service.categoryId);
        required(category && (!category.archived || existing?.serviceId === service.id), 'Категория недоступна');
        const saved: AdminBooking = { ...input, id: existing?.id ?? id(), phone: normalizePhone(input.phone), revision: (existing?.revision ?? 0) + 1 };
        const conflicts = assessBooking(saved, snapshot);
        if (conflicts.length && !allowConflicts) throw new ScheduleConflictError(conflicts);
        if (existing) snapshot.bookings[snapshot.bookings.indexOf(existing)] = saved;
        else snapshot.bookings.push(saved);
        return saved;
      });
    },
    deleteBooking(bookingId, revision) {
      return store.update(snapshot => {
        const existing = revisionOf(snapshot.bookings, bookingId, revision);
        snapshot.bookings.splice(snapshot.bookings.indexOf(existing), 1);
      });
    },
    saveService(input, allowConflicts = false) {
      return store.update(snapshot => {
        const existing = input.id ? revisionOf(snapshot.services, input.id, input.revision) : undefined;
        assertService(input, snapshot, existing);
        const before = copyDemoValue(snapshot);
        const saved: AdminService = { ...input, id: existing?.id ?? id(), archived: existing?.archived ?? false, revision: (existing?.revision ?? 0) + 1 };
        if (existing) snapshot.services[snapshot.services.indexOf(existing)] = saved;
        else snapshot.services.push(saved);
        throwOnImpact(before, snapshot, allowConflicts);
        return saved;
      });
    },
    deleteService(serviceId, revision) {
      return store.update(snapshot => {
        const existing = revisionOf(snapshot.services, serviceId, revision);
        required(!snapshot.bookings.some(booking => booking.serviceId === serviceId), 'Услуга используется в записях. Архивируйте её.');
        snapshot.services.splice(snapshot.services.indexOf(existing), 1);
      });
    },
    setServiceArchived(serviceId, revision, archived) {
      return store.update(snapshot => {
        const existing = revisionOf(snapshot.services, serviceId, revision);
        const saved = { ...existing, archived, revision: existing.revision + 1 };
        snapshot.services[snapshot.services.indexOf(existing)] = saved;
        return saved;
      });
    },
    saveCategory(input, allowConflicts = false) {
      return store.update(snapshot => {
        assertCategory(input);
        const existing = input.id ? revisionOf(snapshot.categories, input.id, input.revision) : undefined;
        const before = copyDemoValue(snapshot);
        const saved: AdminCategory = { ...input, id: existing?.id ?? id(), archived: existing?.archived ?? false, revision: (existing?.revision ?? 0) + 1 };
        if (existing) snapshot.categories[snapshot.categories.indexOf(existing)] = saved;
        else snapshot.categories.push(saved);
        throwOnImpact(before, snapshot, allowConflicts);
        return saved;
      });
    },
    deleteCategory(categoryId, revision) {
      return store.update(snapshot => {
        const existing = revisionOf(snapshot.categories, categoryId, revision);
        required(!snapshot.services.some(service => service.categoryId === categoryId), 'Категория используется в услугах. Архивируйте её.');
        snapshot.categories.splice(snapshot.categories.indexOf(existing), 1);
      });
    },
    setCategoryArchived(categoryId, revision, archived) {
      return store.update(snapshot => {
        const existing = revisionOf(snapshot.categories, categoryId, revision);
        const saved = { ...existing, archived, revision: existing.revision + 1 };
        snapshot.categories[snapshot.categories.indexOf(existing)] = saved;
        return saved;
      });
    },
    saveSettings(input, allowConflicts = false) {
      return store.update(snapshot => {
        if (input.revision !== snapshot.settings.revision) throw new RevisionConflictError();
        const error = validateSettings(input);
        if (error) throw new Error(error);
        const before = copyDemoValue(snapshot);
        const saved: AdminSettings = { workStart: input.workStart, workEnd: input.workEnd, breaks: input.breaks.map(item => ({ ...item })), revision: input.revision + 1 };
        snapshot.settings = saved;
        throwOnImpact(before, snapshot, allowConflicts);
        return saved;
      });
    },
    subscribe: listener => store.subscribe(listener),
  };

  const provider: BookingProvider = {
    async listServices() {
      const snapshot = await store.read();
      return snapshot.services.filter(service => !service.archived && snapshot.categories.some(category => category.id === service.categoryId && !category.archived)).map(({ id, name, priceFrom, durationMinutes }) => ({ id, name, priceFrom, durationMinutes }));
    },
    async getSchedule() {
      const { settings } = await store.read();
      return { workStart: settings.workStart, workEnd: settings.workEnd };
    },
    async getAvailability(serviceId, month) {
      const snapshot = await store.read();
      const service = snapshot.services.find(item => item.id === serviceId);
      const category = snapshot.categories.find(item => item.id === service?.categoryId);
      if (!service || service.archived || !category || category.archived) throw new Error('Услуга не найдена');
      const now = new Date();
      const startDate = todayInMoscow(now);
      const currentMinute = minuteInMoscow(now);
      const endDate = addDays(startDate, 29);
      const days: Availability['days'] = [];
      for (let offset = 0; offset < 30; offset++) {
        const date = addDays(startDate, offset);
        if (!date.startsWith(month)) continue;
        const times: string[] = [];
        for (let minute = snapshot.settings.workStart; minute + service.durationMinutes <= snapshot.settings.workEnd && minute + service.durationMinutes <= 1439; minute += 30) {
          if (date === startDate && minute <= currentMinute) continue;
          const candidate: BookingInput = { serviceId, date, startMinute: minute, durationMinutes: service.durationMinutes, name: '', phone: '', car: '', comment: '', status: 'new' };
          if (assessBooking(candidate, snapshot).length === 0) times.push(formatMinute(minute));
        }
        days.push({ date, times });
      }
      return { timezone, startDate, endDate, days };
    },
    submit(draft) {
      if (Object.keys(validateDraft(draft)).length) return Promise.reject(new SubmissionRejectedError('invalid'));
      return store.update(snapshot => {
        const service = snapshot.services.find(item => item.id === draft.serviceId);
        const category = snapshot.categories.find(item => item.id === service?.categoryId);
        if (!service || service.archived || !category || category.archived) throw new SubmissionRejectedError('invalid');
        let minute: number;
        try { minute = parseMinute(draft.time); } catch { throw new SubmissionRejectedError('unavailable'); }
        const now = new Date();
        const today = todayInMoscow(now);
        const last = addDays(today, 29);
        if (!validDate(draft.date) || draft.date < today || draft.date > last || (draft.date === today && minute <= minuteInMoscow(now)) || minute < snapshot.settings.workStart || (minute - snapshot.settings.workStart) % 30 !== 0 || minute + service.durationMinutes > snapshot.settings.workEnd || minute + service.durationMinutes > 1439) throw new SubmissionRejectedError('unavailable');
        const candidate: BookingInput = { serviceId: draft.serviceId, date: draft.date, startMinute: minute, durationMinutes: service.durationMinutes, name: draft.name.trim(), phone: normalizePhone(draft.phone), car: draft.car.trim(), comment: draft.comment, status: 'new' };
        const conflicts = assessBooking(candidate, snapshot);
        if (conflicts.some(conflict => conflict.kind !== 'capacity')) throw new SubmissionRejectedError('unavailable');
        snapshot.bookings.push({ ...candidate, id: id(), revision: 1 });
        return { status: conflicts.length ? 'overbooked' : 'confirmed', serviceName: service.name, date: draft.date, time: draft.time } as SubmissionResult;
      });
    },
  };
  return { provider, adminProvider };
}

const demo = createDemoProviders(new IndexedDbDemoStore());
export const provider = demo.provider;
export const adminProvider = demo.adminProvider;
