import { describe, expect, it } from 'vitest';
import { adminRouteFromHash, adminRouteHref, allowedAdminSection, visibleAdminSections } from './navigation';

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

  it('opens the audit section from its own hash', () => {
    expect(adminRouteFromHash('#/audit')).toBe('audit');
    expect(adminRouteHref('audit')).toBe('#/audit');
  });

  it('shows sensitive sections only to operators and redirects staff direct hashes', () => {
    expect(visibleAdminSections('staff', false).map(section => section.id)).toEqual(['bookings', 'services', 'categories', 'settings']);
    expect(visibleAdminSections('operator', false).map(section => section.id)).toEqual(['bookings', 'services', 'categories', 'settings', 'audit', 'staff']);
    expect(allowedAdminSection('audit', 'staff', false)).toBe('bookings');
    expect(allowedAdminSection('staff', 'staff', false)).toBe('bookings');
    expect(allowedAdminSection('staff', null, true)).toBe('staff');
  });
});
