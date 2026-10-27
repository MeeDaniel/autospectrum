import type { StaffRole } from '../domain/staff';

export type AdminSection = 'bookings' | 'services' | 'categories' | 'settings' | 'audit' | 'staff';

export const adminSections: ReadonlyArray<{ id: AdminSection; label: string; description: string }> = [
  { id: 'bookings', label: 'Записи', description: 'Просмотр и управление заявками' },
  { id: 'services', label: 'Услуги', description: 'Прайс и продолжительность работ' },
  { id: 'categories', label: 'Категории', description: 'Направления и рабочие линии' },
  { id: 'settings', label: 'Настройки', description: 'Рабочие часы и перерывы' },
  { id: 'audit', label: 'История действий', description: 'Изменения, внесённые сотрудниками' },
  { id: 'staff', label: 'Сотрудники', description: 'Учётные записи и права доступа' },
];

export function visibleAdminSections(role: StaffRole | null, demoMode: boolean) {
  return adminSections.filter(section => demoMode || role === 'operator' || (section.id !== 'audit' && section.id !== 'staff'));
}

export function allowedAdminSection(section: AdminSection, role: StaffRole | null, demoMode: boolean): AdminSection {
  return visibleAdminSections(role, demoMode).some(item => item.id === section) ? section : 'bookings';
}

export function adminRouteFromHash(hash: string): AdminSection {
  const segment = hash.replace(/^#\/?/, '').replace(/\/$/, '');
  return adminSections.find(({ id }) => id === segment)?.id ?? 'bookings';
}

export function adminRouteHref(section: AdminSection): string {
  return `#/${section}`;
}
