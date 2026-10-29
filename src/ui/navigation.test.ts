import { describe, expect, it } from 'vitest';
import { legacyAdminRedirect, routeFromHash, shiftMonth } from './navigation';

describe('booking navigation', () => {
  it('redirects both legacy admin hash routes to the admin app', () => {
    expect(legacyAdminRedirect('#/admin')).toBe('/admin/');
    expect(legacyAdminRedirect('#/admin/')).toBe('/admin/');
  });

  it('keeps unknown hashes on the public form without redirecting', () => {
    expect(legacyAdminRedirect('#/admin/unknown')).toBeNull();
    expect(legacyAdminRedirect('#/missing')).toBeNull();
    expect(routeFromHash('#/admin/unknown')).toBe('form');
  });

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
