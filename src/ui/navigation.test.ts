import { describe, expect, it } from 'vitest';
import { routeFromHash, shiftMonth } from './navigation';

describe('booking navigation', () => {
  it('recognizes public booking routes and sends unknown paths to the form', () => {
    expect(routeFromHash('#/date-time')).toBe('date-time');
    expect(routeFromHash('#/review')).toBe('review');
    expect(routeFromHash('#/result')).toBe('result');
    expect(routeFromHash('#/missing')).toBe('form');
  });

  it('moves across the year boundary when choosing a calendar month', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
  });
});
