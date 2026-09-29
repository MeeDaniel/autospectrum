import { describe, expect, it } from 'vitest';
import { assessBooking, formatMinute, parseMinute, validateSettings } from './admin';
import type { AdminBooking, AdminSnapshot } from './admin';

const snapshot: AdminSnapshot = {
  categories: [{ id: 'c', name: 'Общая', lineCount: 2, archived: false, revision: 1 }],
  services: [{ id: 's', categoryId: 'c', name: 'Диагностика', priceFrom: 1200, durationMinutes: 30, archived: false, revision: 1 }],
  bookings: [],
  settings: { workStart: 540, workEnd: 1080, breaks: [{ start: 720, end: 750 }], revision: 1 },
};
const booking = (id: string, startMinute: number): AdminBooking => ({
  id, serviceId: 's', date: '2026-10-01', startMinute, durationMinutes: 30,
  name: 'Иван', phone: '+79991234567', car: 'Лада', comment: '', status: 'new', revision: 1,
});

describe('minute schedule', () => {
  it('rejects malformed and out of range time', () => {
    expect(parseMinute('23:59')).toBe(1439);
    expect(formatMinute(0)).toBe('00:00');
    expect(() => parseMinute('24:00')).toThrow();
    expect(() => formatMinute(1440)).toThrow();
    expect(() => formatMinute(1.5)).toThrow();
  });

  it('allows adjacency and enough parallel lines but detects actual overload', () => {
    const existing = [booking('a', 600), booking('b', 615)];
    expect(assessBooking(booking('c', 630), { ...snapshot, bookings: existing })).toEqual([]);
    expect(assessBooking(booking('c', 620), { ...snapshot, bookings: existing }).map(c => c.kind)).toContain('capacity');
    expect(assessBooking(booking('a', 620), { ...snapshot, bookings: existing }).map(c => c.kind)).not.toContain('capacity');
  });

  it('reports breaks and closed hours independently of capacity', () => {
    expect(assessBooking(booking('x', 710), snapshot).map(c => c.kind)).toContain('break');
    expect(assessBooking(booking('x', 1070), snapshot).map(c => c.kind)).toContain('hours');
  });

  it('rejects overlapping or out-of-hours breaks', () => {
    expect(validateSettings({ ...snapshot.settings, breaks: [{ start: 720, end: 760 }, { start: 750, end: 780 }] })).toBeTruthy();
    expect(validateSettings({ ...snapshot.settings, breaks: [{ start: 530, end: 560 }] })).toBeTruthy();
    expect(validateSettings(snapshot.settings)).toBeNull();
  });
});
