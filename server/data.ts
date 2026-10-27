import { createHash, randomUUID } from 'node:crypto';
import type { Availability, BookingDraft, Service, SubmissionResult } from '../src/domain/booking';
import { normalizePhone, validateDraft } from '../src/domain/booking';
import type { AdminBooking, AdminBookingFilters, AdminCategory, AdminService, AdminSettings, AdminSnapshot, BookingInput, CategoryInput, Conflict, ServiceInput, SettingsInput } from '../src/domain/admin';
import { formatMinute, occupiesCapacity, parseMinute, validDate, validMinute } from '../src/domain/admin';

export type Queryable = { query(sql: string, values?: unknown[]): Promise<{ rows: any[] }> };
export type DbClient = Queryable & { release(): void };
export type DbPool = Queryable & { connect(): Promise<DbClient> };
export type AuditWriter = (client: DbClient, actorId: string, action: string, entityType: string, entityId: string, before: unknown, after: unknown) => Promise<void>;
export type DataLayerOptions = { now?: () => Date; audit?: AuditWriter };
export type DaySchedule = { closed: boolean; workStart: number; workEnd: number; breaks: { start: number; end: number }[] };

export class DataValidationError extends Error { constructor(message: string) { super(message); this.name = 'DataValidationError'; } }
export class NotFoundError extends Error { constructor(message = 'Запись не найдена') { super(message); this.name = 'NotFoundError'; } }
export class RevisionConflictError extends Error { constructor() { super('Данные изменились. Загрузите актуальную версию.'); this.name = 'RevisionConflictError'; } }
export class ScheduleConflictError extends Error { constructor(public readonly conflicts: Conflict[]) { super('Есть конфликты расписания'); this.name = 'ScheduleConflictError'; } }
export class SubmissionRejectedError extends Error { constructor(public readonly reason: 'invalid' | 'unavailable') { super(reason === 'invalid' ? 'Проверьте данные заявки' : 'Время недоступно'); this.name = 'SubmissionRejectedError'; } }
export class IdempotencyConflictError extends Error { constructor() { super('Ключ заявки уже использован для других данных'); this.name = 'IdempotencyConflictError'; } }

function required(condition: unknown, message: string): asserts condition { if (!condition) throw new DataValidationError(message); }
function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function moscowToday(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const value = (name: string) => parts.find(part => part.type === name)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
function addDays(date: string, count: number): string { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + count); return value.toISOString().slice(0, 10); }
function validHours(day: DaySchedule): boolean {
  if (!day || typeof day !== 'object') return false;
  if (day.closed) return true;
  if (!validMinute(day.workStart) || !validMinute(day.workEnd) || day.workStart >= day.workEnd || !Array.isArray(day.breaks)) return false;
  const sorted = [...day.breaks].sort((a, b) => a.start - b.start);
  return sorted.every((item, index) => validMinute(item.start) && validMinute(item.end) && item.start >= day.workStart && item.end <= day.workEnd && item.start < item.end && (index === 0 || sorted[index - 1].end <= item.start));
}
export function resolveSchedule(settings: AdminSettings, date: string): DaySchedule {
  const extended = settings as AdminSettings & { weekdays?: Record<number, DaySchedule>; exceptions?: Record<string, DaySchedule> };
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return extended.exceptions?.[date] ?? extended.weekdays?.[day] ?? { closed: false, workStart: settings.workStart, workEnd: settings.workEnd, breaks: settings.breaks };
}
export function findConflicts(booking: BookingInput, snapshot: AdminSnapshot): Conflict[] {
  if (!occupiesCapacity(booking.status)) return [];
  const service = snapshot.services.find(item => item.id === booking.serviceId);
  const category = snapshot.categories.find(item => item.id === service?.categoryId);
  if (!service || !category) return [];
  const start = booking.startMinute, end = start + booking.durationMinutes, day = resolveSchedule(snapshot.settings, booking.date);
  const conflicts: Conflict[] = [];
  if (day.closed || start < day.workStart || end > day.workEnd || end > 1439) conflicts.push({ kind: 'hours', bookingIds: [], start, end });
  for (const pause of day.breaks) if (start < pause.end && pause.start < end) conflicts.push({ kind: 'break', bookingIds: [], start: Math.max(start, pause.start), end: Math.min(end, pause.end) });
  const related = snapshot.bookings.filter(other => other.id !== booking.id && other.date === booking.date && occupiesCapacity(other.status) && snapshot.services.find(item => item.id === other.serviceId)?.categoryId === category.id && other.startMinute < end && start < other.startMinute + other.durationMinutes);
  const boundaries = [...new Set([start, end, ...related.flatMap(item => [Math.max(start, item.startMinute), Math.min(end, item.startMinute + item.durationMinutes)])])].sort((a, b) => a - b);
  for (let index = 0; index < boundaries.length - 1; index++) {
    const from = boundaries[index], to = boundaries[index + 1];
    const active = related.filter(item => item.startMinute < to && item.startMinute + item.durationMinutes > from);
    if (from < to && active.length >= category.lineCount) conflicts.push({ kind: 'capacity', bookingIds: active.map(item => item.id), start: from, end: to });
  }
  return conflicts;
}

type BookingFilter = AdminBookingFilters & { date?: string; active?: boolean; dates?: string[]; none?: boolean };
function bookingWhere(filter: BookingFilter = {}): { where: string; values: unknown[] } {
  const clauses: string[] = [], values: unknown[] = [];
  if (filter.none) clauses.push('false');
  if (filter.date) { values.push(filter.date); clauses.push(`date = $${values.length}`); }
  if (filter.from) { values.push(filter.from); clauses.push(`date >= $${values.length}`); }
  if (filter.to) { values.push(filter.to); clauses.push(`date <= $${values.length}`); }
  if (filter.status) { values.push(filter.status); clauses.push(`status = $${values.length}`); }
  if (filter.serviceId) { values.push(filter.serviceId); clauses.push(`service_id = $${values.length}`); }
  if (filter.categoryId) { values.push(filter.categoryId); clauses.push(`EXISTS (SELECT 1 FROM services AS filter_service WHERE filter_service.id = bookings.service_id AND filter_service.category_id = $${values.length})`); }
  const query = filter.query?.trim();
  if (query) {
    values.push(`%${query.replace(/[~%_]/g, '~$&')}%`);
    clauses.push(`(data->>'name' ILIKE $${values.length} ESCAPE '~' OR data->>'phone' ILIKE $${values.length} ESCAPE '~' OR data->>'car' ILIKE $${values.length} ESCAPE '~')`);
  }
  if (filter.active) clauses.push("status IN ('new', 'confirmed')");
  if (filter.dates) { values.push(filter.dates); clauses.push(`date = ANY($${values.length}::date[])`); }
  return { where: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', values };
}
async function readSnapshot(queryable: Queryable, bookingFilter: BookingFilter = {}): Promise<AdminSnapshot> {
  const bookingQuery = bookingWhere(bookingFilter);
  const categories = await queryable.query('SELECT data FROM categories ORDER BY id');
  const services = await queryable.query('SELECT data FROM services ORDER BY id');
  const bookings = bookingFilter.none ? { rows: [] } : await queryable.query(`SELECT data FROM bookings${bookingQuery.where} ORDER BY date, start_minute, id`, bookingQuery.values);
  const settings = await queryable.query('SELECT data FROM settings WHERE id = 1');
  if (!settings.rows[0]) throw new Error('Settings row missing; apply core migration');
  return { categories: categories.rows.map(row => row.data), services: services.rows.map(row => row.data), bookings: bookings.rows.map(row => row.data), settings: settings.rows[0].data };
}
function existing<T extends { id: string; revision: number }>(items: T[], id: string, revision?: number): T {
  const item = items.find(value => value.id === id); if (!item) throw new NotFoundError(); if (item.revision !== revision) throw new RevisionConflictError(); return item;
}
function validateBooking(input: BookingInput): void {
  required(input && typeof input === 'object' && typeof input.name === 'string' && typeof input.phone === 'string' && typeof input.car === 'string' && typeof input.comment === 'string' && typeof input.status === 'string', 'Проверьте данные записи');
  required(validDate(input.date) && validMinute(input.startMinute) && Number.isInteger(input.durationMinutes) && input.durationMinutes > 0 && input.startMinute + input.durationMinutes <= 1439, 'Проверьте дату, время и длительность');
  required(input.name?.trim() && input.car?.trim() && /^\+7\d{10}$/.test(normalizePhone(input.phone)), 'Проверьте данные клиента');
  required(['new', 'confirmed', 'completed', 'cancelled'].includes(input.status), 'Некорректный статус');
}
function validateService(input: ServiceInput, snapshot: AdminSnapshot, prior?: AdminService): void {
  required(input && typeof input === 'object' && typeof input.name === 'string' && typeof input.categoryId === 'string', 'Проверьте услугу');
  required(input.name?.trim() && Number.isFinite(input.priceFrom) && input.priceFrom >= 0 && Number.isInteger(input.durationMinutes) && input.durationMinutes > 0 && input.durationMinutes <= 1439, 'Проверьте услугу');
  required(snapshot.categories.some(category => category.id === input.categoryId && (!category.archived || prior?.categoryId === category.id)), 'Выберите действующую категорию');
}
function impact(before: AdminSnapshot, after: AdminSnapshot): Conflict[] {
  const old = new Map(before.bookings.map(booking => [booking.id, findConflicts(booking, before)]));
  return after.bookings.flatMap(booking => findConflicts(booking, after).filter(conflict => !(old.get(booking.id) ?? []).some(previous => JSON.stringify(previous) === JSON.stringify(conflict))));
}
function assertNoImpact(before: AdminSnapshot, after: AdminSnapshot, allow: boolean): void { const conflicts = impact(before, after); if (conflicts.length && !allow) throw new ScheduleConflictError(conflicts); }
function validateSettings(input: SettingsInput): void {
  required(input && typeof input === 'object' && Array.isArray(input.breaks), 'Проверьте график');
  const extended = input as SettingsInput & { weekdays?: Record<number, DaySchedule>; exceptions?: Record<string, DaySchedule> };
  required(validHours({ closed: false, workStart: input.workStart, workEnd: input.workEnd, breaks: input.breaks }), 'Проверьте рабочие часы');
  required(extended.weekdays && Object.keys(extended.weekdays).length === 7 && Array.from({ length: 7 }, (_, day) => day).every(day => validHours(extended.weekdays![day])), 'Проверьте график по дням недели');
  required(extended.exceptions && Object.entries(extended.exceptions).every(([date, value]) => validDate(date) && validHours(value)), 'Проверьте исключения графика');
}

export function createDataLayer(pool: DbPool, options: DataLayerOptions = {}) {
  const now = options.now ?? (() => new Date());
  async function transaction<T>(work: (client: DbClient, snapshot: AdminSnapshot) => Promise<T>, bookingFilter: BookingFilter = {}): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM schedule_state WHERE id = 1 FOR UPDATE');
      const snapshot = await readSnapshot(client, bookingFilter);
      const result = await work(client, snapshot);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
      throw error;
    } finally { client.release(); }
  }
  async function audit(client: DbClient, actorId: string, action: string, type: string, id: string, before: unknown, after: unknown): Promise<void> {
    if (options.audit) await options.audit(client, actorId, action, type, id, before, after);
  }
  async function persist(client: DbClient, table: 'categories' | 'services' | 'bookings', value: AdminCategory | AdminService | AdminBooking): Promise<void> {
    if (table === 'categories') await client.query('INSERT INTO categories (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data', [value.id, JSON.stringify(value)]);
    else if (table === 'services') {
      const service = value as AdminService;
      await client.query('INSERT INTO services (id, category_id, data) VALUES ($1, $2, $3::jsonb) ON CONFLICT (id) DO UPDATE SET category_id = EXCLUDED.category_id, data = EXCLUDED.data', [service.id, service.categoryId, JSON.stringify(service)]);
    } else {
      const booking = value as AdminBooking;
      await client.query('INSERT INTO bookings (id, service_id, date, status, data) VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (id) DO UPDATE SET service_id = EXCLUDED.service_id, date = EXCLUDED.date, status = EXCLUDED.status, data = EXCLUDED.data', [booking.id, booking.serviceId, booking.date, booking.status, JSON.stringify(booking)]);
    }
  }
  return {
    async listServices(): Promise<Service[]> {
      const snapshot = await readSnapshot(pool, { none: true });
      return snapshot.services.filter(service => !service.archived && snapshot.categories.some(category => category.id === service.categoryId && !category.archived)).map(({ id, name, priceFrom, durationMinutes }) => ({ id, name, priceFrom, durationMinutes }));
    },
    async getSchedule(): Promise<AdminSettings> { return (await readSnapshot(pool, { none: true })).settings; },
    async getAvailability(serviceId: string, month: string): Promise<Availability> {
      required(/^\d{4}-(0[1-9]|1[0-2])$/.test(month), 'Некорректный месяц');
      const today = moscowToday(now()), startDate = addDays(today, 1), endDate = addDays(today, 30);
      const snapshot = await readSnapshot(pool, { from: startDate, to: endDate, active: true });
      const service = snapshot.services.find(item => item.id === serviceId);
      const category = snapshot.categories.find(item => item.id === service?.categoryId);
      if (!service || service.archived || !category || category.archived) throw new NotFoundError('Услуга не найдена');
      const days: Availability['days'] = [];
      for (let offset = 1; offset <= 30; offset++) {
        const date = addDays(today, offset); if (!date.startsWith(month)) continue;
        const schedule = resolveSchedule(snapshot.settings, date), times: string[] = [];
        if (!schedule.closed) for (let minute = Math.ceil(schedule.workStart / 30) * 30; minute + service.durationMinutes <= schedule.workEnd && minute + service.durationMinutes <= 1439; minute += 30) {
          const candidate: BookingInput = { serviceId, date, startMinute: minute, durationMinutes: service.durationMinutes, name: '', phone: '', car: '', comment: '', status: 'new' };
          if (!findConflicts(candidate, snapshot).length) times.push(formatMinute(minute));
        }
        days.push({ date, times });
      }
      return { timezone: 'Europe/Moscow', startDate, endDate, days };
    },
    async submit(draft: BookingDraft, idempotencyKey: string): Promise<SubmissionResult> {
      if (!draft || typeof draft !== 'object' || !['serviceId', 'date', 'time', 'name', 'phone', 'car', 'comment'].every(key => typeof (draft as unknown as Record<string, unknown>)[key] === 'string')) throw new SubmissionRejectedError('invalid');
      if (Object.keys(validateDraft(draft)).length) throw new SubmissionRejectedError('invalid');
      required(typeof idempotencyKey === 'string' && idempotencyKey.length >= 1 && idempotencyKey.length <= 200, 'Некорректный ключ заявки');
      const hash = createHash('sha256').update(JSON.stringify(draft)).digest('hex');
      return transaction(async (client, snapshot) => {
        const old = await client.query('SELECT request_hash, response FROM idempotency_keys WHERE key = $1', [idempotencyKey]);
        if (old.rows[0]) {
          if (old.rows[0].request_hash !== hash) throw new IdempotencyConflictError();
          return old.rows[0].response as SubmissionResult;
        }
        const service = snapshot.services.find(item => item.id === draft.serviceId);
        const category = snapshot.categories.find(item => item.id === service?.categoryId);
        if (!service || service.archived || !category || category.archived) throw new SubmissionRejectedError('invalid');
        let startMinute: number;
        try { startMinute = parseMinute(draft.time); } catch { throw new SubmissionRejectedError('unavailable'); }
        const today = moscowToday(now());
        if (!validDate(draft.date) || draft.date < addDays(today, 1) || draft.date > addDays(today, 30) || startMinute % 30 !== 0 || startMinute + service.durationMinutes > 1439) throw new SubmissionRejectedError('unavailable');
        const booking: AdminBooking = { id: randomUUID(), serviceId: service.id, date: draft.date, startMinute, durationMinutes: service.durationMinutes, name: draft.name.trim(), phone: normalizePhone(draft.phone), car: draft.car.trim(), comment: draft.comment, status: 'new', revision: 1 };
        const conflicts = findConflicts(booking, snapshot);
        const response: SubmissionResult = { status: conflicts.length ? 'overbooked' : 'confirmed', serviceName: service.name, date: draft.date, time: draft.time };
        await persist(client, 'bookings', booking);
        await client.query('INSERT INTO idempotency_keys (key, request_hash, response) VALUES ($1, $2, $3::jsonb)', [idempotencyKey, hash, JSON.stringify(response)]);
        return response;
      }, { date: draft.date, active: true });
    },
    async getAdminSnapshot(filters?: { date?: string; from?: string; to?: string; status?: AdminBooking['status'] }): Promise<AdminSnapshot> {
      return readSnapshot(pool, { ...filters, active: true });
    },
    async listAdminBookings(filters: AdminBookingFilters & { date?: string } = {}, limit = 50, cursor?: string): Promise<{ bookings: AdminBooking[]; total: number; nextCursor: string | null; conflicts: Record<string, Conflict[]> }> {
      required(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'Некорректный размер страницы');
      for (const date of [filters.date, filters.from, filters.to]) if (date !== undefined) required(validDate(date), 'Некорректная дата');
      if (filters.status !== undefined) required(['new', 'confirmed', 'completed', 'cancelled'].includes(filters.status), 'Некорректный статус');
      for (const value of [filters.query, filters.categoryId, filters.serviceId]) if (value !== undefined) required(typeof value === 'string', 'Некорректный фильтр');
      const base = bookingWhere(filters);
      const count = await pool.query(`SELECT count(*)::text AS total FROM bookings${base.where}`, base.values);
      const values = [...base.values], clauses = base.where ? [base.where.slice(7)] : [];
      if (cursor !== undefined) {
        let decoded: unknown;
        try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw new DataValidationError('Некорректный указатель страницы'); }
        const key = decoded as { date?: unknown; startMinute?: unknown; id?: unknown } | null;
        required(key && validDate(key.date as string) && validMinute(key.startMinute as number) && typeof key.id === 'string' && key.id.length > 0, 'Некорректный указатель страницы');
        values.push(key.date, key.startMinute, key.id);
        clauses.push(`(date, start_minute, id) < ($${values.length - 2}::date, $${values.length - 1}::integer, $${values.length}::text)`);
      }
      values.push(limit + 1);
      const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
      const result = await pool.query(`SELECT data FROM bookings${where} ORDER BY date DESC, start_minute DESC, id DESC LIMIT $${values.length}`, values);
      const hasMore = result.rows.length > limit;
      const bookings = result.rows.slice(0, limit).map(row => row.data as AdminBooking);
      const last = bookings.at(-1);
      const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({ date: last.date, startMinute: last.startMinute, id: last.id })).toString('base64url') : null;
      const dates = [...new Set(bookings.map(booking => booking.date))];
      const snapshot = dates.length ? await readSnapshot(pool, { dates, active: true }) : null;
      const conflicts = Object.fromEntries(bookings.map(booking => [booking.id, snapshot ? findConflicts(booking, snapshot) : []]));
      return { bookings, total: Number(count.rows[0]?.total ?? 0), nextCursor, conflicts };
    },
    async previewBooking(input: BookingInput): Promise<Conflict[]> { validateBooking(input); return findConflicts(input, await readSnapshot(pool, { date: input.date, active: true })); },
    async saveBooking(input: BookingInput, allowConflicts = false, actorId = ''): Promise<AdminBooking> {
      validateBooking(input);
      return transaction(async (client, snapshot) => {
        const priorRows = input.id ? await client.query('SELECT data FROM bookings WHERE id = $1', [input.id]) : null;
        const prior = input.id ? existing(priorRows!.rows.map(row => row.data as AdminBooking), input.id, input.revision) : undefined;
        const service = snapshot.services.find(item => item.id === input.serviceId);
        const category = snapshot.categories.find(item => item.id === service?.categoryId);
        required(service && (!service.archived || prior?.serviceId === service.id) && category && (!category.archived || prior?.serviceId === service.id), 'Услуга недоступна');
        const saved: AdminBooking = { ...input, id: prior?.id ?? randomUUID(), phone: normalizePhone(input.phone), revision: (prior?.revision ?? 0) + 1 };
        const conflicts = findConflicts(saved, snapshot); if (conflicts.length && !allowConflicts) throw new ScheduleConflictError(conflicts);
        await persist(client, 'bookings', saved); await audit(client, actorId, prior ? 'update' : 'create', 'booking', saved.id, prior ?? null, saved);
        return saved;
      }, { date: input.date, active: true });
    },
    async deleteBooking(id: string, revision: number, actorId = ''): Promise<void> {
      return transaction(async client => { const rows = await client.query('SELECT data FROM bookings WHERE id = $1', [id]); const prior = existing(rows.rows.map(row => row.data as AdminBooking), id, revision); await client.query('DELETE FROM bookings WHERE id = $1', [id]); await audit(client, actorId, 'delete', 'booking', id, prior, null); }, { none: true });
    },
    async saveService(input: ServiceInput, allowConflicts = false, actorId = ''): Promise<AdminService> {
      return transaction(async (client, snapshot) => {
        required(input && typeof input === 'object', 'Проверьте услугу');
        const prior = input.id ? existing(snapshot.services, input.id, input.revision) : undefined;
        validateService(input, snapshot, prior);
        const before = copy(snapshot);
        const saved: AdminService = { ...input, id: prior?.id ?? randomUUID(), archived: prior?.archived ?? false, revision: (prior?.revision ?? 0) + 1 };
        if (prior) snapshot.services[snapshot.services.indexOf(prior)] = saved; else snapshot.services.push(saved);
        assertNoImpact(before, snapshot, allowConflicts);
        await persist(client, 'services', saved); await audit(client, actorId, prior ? 'update' : 'create', 'service', saved.id, prior ?? null, saved);
        return saved;
      }, { from: moscowToday(now()), active: true });
    },
    async deleteService(id: string, revision: number, actorId = ''): Promise<void> {
      return transaction(async (client, snapshot) => { const prior = existing(snapshot.services, id, revision); const referenced = await client.query('SELECT 1 FROM bookings WHERE service_id = $1 LIMIT 1', [id]); required(!referenced.rows.length, 'Услуга используется в записях. Архивируйте её.'); await client.query('DELETE FROM services WHERE id = $1', [id]); await audit(client, actorId, 'delete', 'service', id, prior, null); }, { none: true });
    },
    async setServiceArchived(id: string, revision: number, archived: boolean, actorId = ''): Promise<AdminService> {
      return transaction(async (client, snapshot) => { const prior = existing(snapshot.services, id, revision); const saved = { ...prior, archived, revision: prior.revision + 1 }; await persist(client, 'services', saved); await audit(client, actorId, archived ? 'archive' : 'restore', 'service', id, prior, saved); return saved; }, { none: true });
    },
    async saveCategory(input: CategoryInput, allowConflicts = false, actorId = ''): Promise<AdminCategory> {
      return transaction(async (client, snapshot) => {
        required(input && typeof input === 'object' && typeof input.name === 'string', 'Проверьте категорию');
        required(input.name?.trim() && Number.isInteger(input.lineCount) && input.lineCount >= 0, 'Проверьте категорию');
        const prior = input.id ? existing(snapshot.categories, input.id, input.revision) : undefined;
        const before = copy(snapshot);
        const saved: AdminCategory = { ...input, id: prior?.id ?? randomUUID(), archived: prior?.archived ?? false, revision: (prior?.revision ?? 0) + 1 };
        if (prior) snapshot.categories[snapshot.categories.indexOf(prior)] = saved; else snapshot.categories.push(saved);
        assertNoImpact(before, snapshot, allowConflicts);
        await persist(client, 'categories', saved); await audit(client, actorId, prior ? 'update' : 'create', 'category', saved.id, prior ?? null, saved);
        return saved;
      }, { from: moscowToday(now()), active: true });
    },
    async deleteCategory(id: string, revision: number, actorId = ''): Promise<void> {
      return transaction(async (client, snapshot) => { const prior = existing(snapshot.categories, id, revision); required(!snapshot.services.some(item => item.categoryId === id), 'Категория используется в услугах. Архивируйте её.'); await client.query('DELETE FROM categories WHERE id = $1', [id]); await audit(client, actorId, 'delete', 'category', id, prior, null); }, { none: true });
    },
    async setCategoryArchived(id: string, revision: number, archived: boolean, actorId = ''): Promise<AdminCategory> {
      return transaction(async (client, snapshot) => { const prior = existing(snapshot.categories, id, revision); const saved = { ...prior, archived, revision: prior.revision + 1 }; await persist(client, 'categories', saved); await audit(client, actorId, archived ? 'archive' : 'restore', 'category', id, prior, saved); return saved; }, { none: true });
    },
    async saveSettings(input: SettingsInput, allowConflicts = false, actorId = ''): Promise<AdminSettings> {
      return transaction(async (client, snapshot) => {
        required(input && typeof input === 'object', 'Проверьте график');
        if (input.revision !== snapshot.settings.revision) throw new RevisionConflictError();
        validateSettings(input);
        const before = copy(snapshot), saved = { ...copy(input), revision: input.revision + 1 } as AdminSettings;
        snapshot.settings = saved; assertNoImpact(before, snapshot, allowConflicts);
        await client.query('UPDATE settings SET data = $1::jsonb WHERE id = 1', [JSON.stringify(saved)]);
        await audit(client, actorId, 'update', 'settings', '1', before.settings, saved);
        return saved;
      }, { from: moscowToday(now()), active: true });
    },
  };
}
