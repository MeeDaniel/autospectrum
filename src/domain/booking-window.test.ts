import { describe, expect, it } from 'vitest';
import { bookingWindow, isBookableDate } from './booking-window';

describe('Moscow public booking window', () => {
  it('excludes today and day 61 while including tomorrow and day 60', () => {
    const window = bookingWindow(new Date('2026-10-27T12:00:00Z'));

    expect(window).toEqual({ startDate: '2026-10-28', endDate: '2026-12-26' });
    expect(isBookableDate('2026-10-27', window)).toBe(false);
    expect(isBookableDate('2026-10-28', window)).toBe(true);
    expect(isBookableDate('2026-12-26', window)).toBe(true);
    expect(isBookableDate('2026-12-27', window)).toBe(false);
  });

  it('crosses a year boundary using Moscow calendar dates', () => {
    expect(bookingWindow(new Date('2026-12-31T12:00:00Z'))).toEqual({
      startDate: '2027-01-01', endDate: '2027-03-01',
    });
  });

  it('includes leap day when February has 29 days', () => {
    expect(bookingWindow(new Date('2024-02-28T12:00:00Z'))).toEqual({
      startDate: '2024-02-29', endDate: '2024-04-28',
    });
  });

  it('changes its calendar day at Moscow midnight', () => {
    expect(bookingWindow(new Date('2026-10-27T20:59:59Z'))).toEqual({
      startDate: '2026-10-28', endDate: '2026-12-26',
    });
    expect(bookingWindow(new Date('2026-10-27T21:00:00Z'))).toEqual({
      startDate: '2026-10-29', endDate: '2026-12-27',
    });
  });
});
