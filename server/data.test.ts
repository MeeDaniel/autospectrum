import { describe, expect, it } from 'vitest';
import { createDataLayer, DataValidationError, findConflicts, IdempotencyConflictError, resolveSchedule, RevisionConflictError, ScheduleConflictError } from './data';
import type { AdminSnapshot } from '../src/domain/admin';

const weekdays = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, { closed: day === 0, workStart: 540, workEnd: 1080, breaks: [] }]));
const settings = { workStart: 540, workEnd: 1080, breaks: [], weekdays, exceptions: {}, revision: 1 };
const snapshot: AdminSnapshot = {
  categories: [{ id: 'general', name: 'General', lineCount: 1, archived: false, revision: 1 }],
  services: [{ id: 'oil', categoryId: 'general', name: 'Oil', priceFrom: 1500, durationMinutes: 60, archived: false, revision: 1 }],
  bookings: [], settings,
} as AdminSnapshot;

function fakePool(initial: AdminSnapshot = snapshot) {
  const state = structuredClone(initial);
  const idempotency = new Map<string, { request_hash: string; response: unknown }>();
  const commands: string[] = [];
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      commands.push(sql);
      calls.push({ sql, values });
      if (/^SELECT data FROM categories/.test(sql)) return { rows: state.categories.map(data => ({ data })) };
      if (/^SELECT data FROM services/.test(sql)) return { rows: state.services.map(data => ({ data })) };
      if (/^SELECT count\(\*\)/.test(sql)) return { rows: [{ total: state.bookings.length }] };
      if (sql === 'SELECT data FROM bookings WHERE id = $1') return { rows: state.bookings.filter(item => item.id === values[0]).map(data => ({ data })) };
      if (sql === 'SELECT 1 FROM bookings WHERE service_id = $1 LIMIT 1') return { rows: state.bookings.some(item => item.serviceId === values[0]) ? [{ '?column?': 1 }] : [] };
      if (/^SELECT data FROM bookings/.test(sql)) {
        if (sql.includes('LIMIT')) {
          const order = (a: { date: string; startMinute: number; id: string }, b: { date: string; startMinute: number; id: string }) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute || a.id.localeCompare(b.id);
          let rows = [...state.bookings].sort((a, b) => -order(a, b));
          if (sql.includes('(date, start_minute, id) <')) {
            const key = { date: String(values.at(-4)), startMinute: Number(values.at(-3)), id: String(values.at(-2)) };
            rows = rows.filter(item => order(item, key) < 0);
          }
          return { rows: rows.slice(0, Number(values.at(-1))).map(data => ({ data })) };
        }
        return { rows: state.bookings.map(data => ({ data })) };
      }
      if (/^SELECT data FROM settings/.test(sql)) return { rows: [{ data: state.settings }] };
      if (/^SELECT request_hash, response FROM idempotency_keys/.test(sql)) {
        const item = idempotency.get(String(values[0])); return { rows: item ? [item] : [] };
      }
      if (/^INSERT INTO bookings/.test(sql)) { state.bookings.push(JSON.parse(String(values[4]))); return { rows: [] }; }
      if (/^INSERT INTO idempotency_keys/.test(sql)) { idempotency.set(String(values[0]), { request_hash: String(values[1]), response: JSON.parse(String(values[2])) }); return { rows: [] }; }
      return { rows: [] };
    },
    release() {},
  };
  return { pool: { connect: async () => client, query: client.query.bind(client) }, state, commands, calls };
}

describe('schedule rules', () => {
  it('uses a date exception over the weekday and keeps Sunday closed', () => {
    const configured = { ...settings, exceptions: { '2026-10-18': { closed: false, workStart: 600, workEnd: 900, breaks: [{ start: 720, end: 750 }] } } };
    expect(resolveSchedule(configured, '2026-10-18')).toEqual({ closed: false, workStart: 600, workEnd: 900, breaks: [{ start: 720, end: 750 }] });
    expect(resolveSchedule(settings, '2026-10-18').closed).toBe(true);
  });

  it('finds capacity, break, and hours conflicts independently', () => {
    const configured = structuredClone(snapshot);
    configured.bookings.push({ id: 'existing', serviceId: 'oil', date: '2026-10-19', startMinute: 600, durationMinutes: 60, name: 'A', phone: '+79999999999', car: 'Car', comment: '', status: 'confirmed', revision: 1 });
    configured.settings.weekdays![1]!.breaks = [{ start: 630, end: 645 }];
    const candidate = { serviceId: 'oil', date: '2026-10-19', startMinute: 600, durationMinutes: 60, name: 'B', phone: '+79999999998', car: 'Car', comment: '', status: 'new' as const };
    expect(findConflicts(candidate, configured).map(item => item.kind)).toEqual(expect.arrayContaining(['capacity', 'break']));
    expect(findConflicts({ ...candidate, startMinute: 1050 }, configured).some(item => item.kind === 'hours')).toBe(true);
  });
});

describe('public data operations', () => {
  it('shows only half-hour slots from tomorrow through day 30 in Moscow', async () => {
    const { pool, calls } = fakePool();
    const data = createDataLayer(pool, { now: () => new Date('2026-10-12T09:00:00Z') });
    const availability = await data.getAvailability('oil', '2026-10');
    expect(availability.startDate).toBe('2026-10-13');
    expect(availability.endDate).toBe('2026-11-11');
    expect(availability.days[0].date).toBe('2026-10-13');
    expect(availability.days[0].times.slice(0, 3)).toEqual(['09:00', '09:30', '10:00']);
    expect(availability.days.find(day => day.date === '2026-10-18')?.times).toEqual([]);
    expect(calls.some(call => call.sql.startsWith('SELECT data FROM bookings WHERE') && call.values.includes('2026-10-13') && call.values.includes('2026-11-11'))).toBe(true);
  });

  it('serializes submit, returns overbooked for any schedule conflict, and replays the same key once', async () => {
    const configured = structuredClone(snapshot);
    configured.bookings.push({ id: 'existing', serviceId: 'oil', date: '2026-10-13', startMinute: 600, durationMinutes: 60, name: 'A', phone: '+79999999999', car: 'Car', comment: '', status: 'confirmed', revision: 1 });
    const { pool, state, commands, calls } = fakePool(configured);
    const data = createDataLayer(pool, { now: () => new Date('2026-10-12T09:00:00Z') });
    const draft = { serviceId: 'oil', date: '2026-10-13', time: '10:00', name: 'B', phone: '9999999998', car: 'Car', comment: '' };
    const first = await data.submit(draft, 'request-1');
    const replay = await data.submit(draft, 'request-1');
    expect(first.status).toBe('overbooked');
    expect(replay).toEqual(first);
    expect(state.bookings).toHaveLength(2);
    expect(commands).toContain('SELECT id FROM schedule_state WHERE id = 1 FOR UPDATE');
    expect(commands.filter(sql => sql === 'COMMIT')).toHaveLength(2);
    expect(calls.some(call => call.sql.startsWith('SELECT data FROM bookings WHERE') && call.values.includes('2026-10-13'))).toBe(true);
  });

  it('rejects a reused idempotency key with different request data', async () => {
    const { pool, state } = fakePool();
    const data = createDataLayer(pool, { now: () => new Date('2026-10-12T09:00:00Z') });
    const draft = { serviceId: 'oil', date: '2026-10-13', time: '10:00', name: 'B', phone: '9999999998', car: 'Car', comment: '' };
    await data.submit(draft, 'request-2');
    await expect(data.submit({ ...draft, name: 'C' }, 'request-2')).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(state.bookings).toHaveLength(1);
  });

  it('accepts a closed-day submission as overbooked when it is otherwise valid', async () => {
    const { pool, state } = fakePool();
    const data = createDataLayer(pool, { now: () => new Date('2026-10-12T09:00:00Z') });
    const result = await data.submit({ serviceId: 'oil', date: '2026-10-18', time: '10:00', name: 'B', phone: '9999999998', car: 'Car', comment: '' }, 'request-closed');
    expect(result.status).toBe('overbooked');
    expect(state.bookings).toHaveLength(1);
  });

  it('rejects unsupported booking statuses before writing', async () => {
    const { pool, commands } = fakePool();
    const data = createDataLayer(pool);
    const input = { serviceId: 'oil', date: '2026-10-19', startMinute: 555, durationMinutes: 60, name: 'B', phone: '9999999998', car: 'Car', comment: '', status: 'in_progress' as never };
    await expect(data.saveBooking(input)).rejects.toBeInstanceOf(DataValidationError);
    expect(commands.some(sql => sql.startsWith('INSERT INTO bookings'))).toBe(false);
  });

  it('returns a validation error for malformed public and admin payloads', async () => {
    const { pool } = fakePool();
    const data = createDataLayer(pool);
    await expect(data.submit(null as never, 'bad-public')).rejects.toMatchObject({ reason: 'invalid' });
    await expect(data.saveBooking(null as never)).rejects.toBeInstanceOf(DataValidationError);
  });

  it('rolls back an admin change when the audit writer fails', async () => {
    const { pool, commands } = fakePool();
    const data = createDataLayer(pool, { audit: async () => { throw new Error('audit unavailable'); } });
    const input = { serviceId: 'oil', date: '2026-10-19', startMinute: 555, durationMinutes: 60, name: 'B', phone: '9999999998', car: 'Car', comment: '', status: 'confirmed' as const };
    await expect(data.saveBooking(input, false, 'staff-1')).rejects.toThrow('audit unavailable');
    expect(commands).toContain('ROLLBACK');
    expect(commands).not.toContain('COMMIT');
  });

  it('refuses to delete a service referenced by a booking', async () => {
    const configured = structuredClone(snapshot);
    configured.bookings.push({ id: 'existing', serviceId: 'oil', date: '2026-10-19', startMinute: 600, durationMinutes: 60, name: 'A', phone: '+79999999999', car: 'Car', comment: '', status: 'completed', revision: 1 });
    const { pool, commands } = fakePool(configured);
    const data = createDataLayer(pool);
    await expect(data.deleteService('oil', 1, 'staff-1')).rejects.toBeInstanceOf(DataValidationError);
    expect(commands.some(sql => sql.startsWith('DELETE FROM services'))).toBe(false);
  });

  it('rejects a stale service revision before persisting', async () => {
    const { pool, commands } = fakePool();
    const data = createDataLayer(pool);
    await expect(data.saveService({ id: 'oil', revision: 0, categoryId: 'general', name: 'Fresh oil', priceFrom: 1500, durationMinutes: 60 }, false, 'staff-1')).rejects.toBeInstanceOf(RevisionConflictError);
    expect(commands.some(sql => sql.startsWith('INSERT INTO services'))).toBe(false);
  });

  it('loads only the target booking and new date when an admin moves a booking', async () => {
    const configured = structuredClone(snapshot);
    configured.bookings.push({ id: 'existing', serviceId: 'oil', date: '2026-10-19', startMinute: 600, durationMinutes: 60, name: 'A', phone: '+79999999999', car: 'Car', comment: '', status: 'confirmed', revision: 1 });
    const { pool, calls } = fakePool(configured);
    const data = createDataLayer(pool);
    await data.saveBooking({ id: 'existing', revision: 1, serviceId: 'oil', date: '2026-10-20', startMinute: 615, durationMinutes: 60, name: 'A', phone: '+79999999999', car: 'Car', comment: '', status: 'confirmed' }, false, 'staff-1');
    expect(calls.some(call => call.sql === 'SELECT data FROM bookings WHERE id = $1' && call.values[0] === 'existing')).toBe(true);
    expect(calls.some(call => call.sql.startsWith('SELECT data FROM bookings WHERE date =') && call.values.includes('2026-10-20'))).toBe(true);
    expect(calls.some(call => call.sql === 'SELECT data FROM bookings ORDER BY date, start_minute, id')).toBe(false);
  });

  it('requires an override when closing a day that already contains a booking', async () => {
    const configured = structuredClone(snapshot);
    configured.bookings.push({ id: 'existing', serviceId: 'oil', date: '2026-10-19', startMinute: 600, durationMinutes: 60, name: 'A', phone: '+79999999999', car: 'Car', comment: '', status: 'confirmed', revision: 1 });
    const { pool, commands } = fakePool(configured);
    const data = createDataLayer(pool);
    const next = structuredClone(configured.settings);
    next.weekdays![1]!.closed = true;
    await expect(data.saveSettings(next, false, 'staff-1')).rejects.toBeInstanceOf(ScheduleConflictError);
    expect(commands.some(sql => sql.startsWith('UPDATE settings'))).toBe(false);
  });

  it('filters the admin snapshot in SQL when a date window is supplied', async () => {
    const { pool, calls } = fakePool();
    const data = createDataLayer(pool);
    await data.getAdminSnapshot({ from: '2026-10-01', to: '2026-10-31' });
    expect(calls.some(call => call.sql.startsWith('SELECT data FROM bookings WHERE') && call.values.includes('2026-10-01') && call.values.includes('2026-10-31'))).toBe(true);
  });

  it('pages admin bookings and checks page conflicts against all bookings on those dates', async () => {
    const configured = structuredClone(snapshot);
    configured.bookings.push(
      { id: 'a', serviceId: 'oil', date: '2026-10-19', startMinute: 600, durationMinutes: 60, name: 'A', phone: '+79999999999', car: 'Car', comment: '', status: 'confirmed', revision: 1 },
      { id: 'b', serviceId: 'oil', date: '2026-10-19', startMinute: 600, durationMinutes: 60, name: 'B', phone: '+79999999998', car: 'Car', comment: '', status: 'confirmed', revision: 1 },
      { id: 'c', serviceId: 'oil', date: '2026-10-18', startMinute: 600, durationMinutes: 60, name: 'C', phone: '+79999999997', car: 'Car', comment: '', status: 'completed', revision: 1 },
    );
    const { pool, calls } = fakePool(configured);
    const data = createDataLayer(pool);
    const page = await data.listAdminBookings({}, 2);
    expect(page.bookings).toHaveLength(2);
    expect(page.total).toBe(3);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(page.conflicts.a.some(conflict => conflict.kind === 'capacity')).toBe(true);
    expect(calls.some(call => call.sql.includes('LIMIT') && call.values.includes(3))).toBe(true);
    const next = await data.listAdminBookings({}, 2, page.nextCursor!);
    expect(next.bookings.map(booking => booking.id)).toEqual(['c']);
    expect(next.nextCursor).toBeNull();
  });
});
