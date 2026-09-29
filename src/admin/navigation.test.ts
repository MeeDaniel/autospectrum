import { describe, expect, it } from 'vitest';
import { adminRouteFromHash, adminRouteHref } from './navigation';

describe('admin navigation', () => {
  it('opens bookings for an empty or unknown hash', () => {
    expect(adminRouteFromHash('')).toBe('bookings');
    expect(adminRouteFromHash('#/unknown')).toBe('bookings');
  });

  it('keeps admin sections independent from client routes', () => {
    expect(adminRouteFromHash('#/services')).toBe('services');
    expect(adminRouteFromHash('#/categories')).toBe('categories');
    expect(adminRouteFromHash('#/settings')).toBe('settings');
    expect(adminRouteHref('settings')).toBe('#/settings');
    expect(adminRouteFromHash('#/review')).toBe('bookings');
  });
});
