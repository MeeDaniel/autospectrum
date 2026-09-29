import { describe, expect, it } from 'vitest';
import type { AdminSnapshot } from '../../domain/admin';
import { filterBookings, impactedBookings } from './section-model';

const snapshot: AdminSnapshot = {
  categories: [{ id: 'wash', name: 'Мойка', lineCount: 1, archived: false, revision: 1 }],
  services: [{ id: 'quick', categoryId: 'wash', name: 'Экспресс', priceFrom: 1000, durationMinutes: 30, archived: false, revision: 1 }],
  settings: { workStart: 540, workEnd: 1080, breaks: [], revision: 1 },
  bookings: [
    { id: 'a', serviceId: 'quick', date: '2026-09-29', startMinute: 600, durationMinutes: 30, name: 'Анна', phone: '+7 999 111', car: 'Лада', comment: '', status: 'new', revision: 1 },
    { id: 'b', serviceId: 'quick', date: '2026-09-30', startMinute: 600, durationMinutes: 30, name: 'Борис', phone: '+7 999 222', car: 'Киа', comment: '', status: 'cancelled', revision: 1 },
  ],
};

describe('admin section model', () => {
  it('finds bookings by customer, phone or car and applies date/status filters', () => {
    expect(filterBookings(snapshot, { query: 'лада', date: '', status: '', categoryId: '', serviceId: '', conflictsOnly: false }).map(item => item.id)).toEqual(['a']);
    expect(filterBookings(snapshot, { query: '222', date: '2026-09-30', status: 'cancelled', categoryId: '', serviceId: '', conflictsOnly: false }).map(item => item.id)).toEqual(['b']);
    expect(filterBookings(snapshot, { query: '', date: '2026-09-29', status: 'cancelled', categoryId: '', serviceId: '', conflictsOnly: false })).toEqual([]);
  });

  it('reports schedule impact when a new break overlaps an existing booking', () => {
    const proposed = { ...snapshot, settings: { ...snapshot.settings, breaks: [{ start: 605, end: 620 }] } };
    expect(impactedBookings(snapshot, proposed).map(item => item.id)).toEqual(['a']);
  });

  it('does not count cancelled bookings as schedule conflicts', () => {
    const proposed = { ...snapshot, settings: { ...snapshot.settings, workEnd: 590 } };
    expect(impactedBookings(snapshot, proposed).map(item => item.id)).toEqual(['a']);
  });

  it('reports a new conflict even when the booking already had another warning', () => {
    const current = { ...snapshot, settings: { ...snapshot.settings, workStart: 610 } };
    const proposed = { ...current, settings: { ...current.settings, breaks: [{ start: 615, end: 625 }] } };
    expect(impactedBookings(current, proposed).map(item => item.id)).toEqual(['a']);
  });
});
