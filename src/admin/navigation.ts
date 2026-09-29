export type AdminSection = 'bookings' | 'services' | 'categories' | 'settings';

export const adminSections: ReadonlyArray<{ id: AdminSection; label: string; description: string }> = [
  { id: 'bookings', label: 'Записи', description: 'Просмотр и управление заявками' },
  { id: 'services', label: 'Услуги', description: 'Прайс и продолжительность работ' },
  { id: 'categories', label: 'Категории', description: 'Направления и рабочие линии' },
  { id: 'settings', label: 'Настройки', description: 'Рабочие часы и перерывы' },
];

export function adminRouteFromHash(hash: string): AdminSection {
  const segment = hash.replace(/^#\/?/, '').replace(/\/$/, '');
  return adminSections.find(({ id }) => id === segment)?.id ?? 'bookings';
}

export function adminRouteHref(section: AdminSection): string {
  return `#/${section}`;
}
