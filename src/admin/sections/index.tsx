import type { AdminSection } from '../navigation';
import { BookingsSection } from './BookingsSection';
import { CategoriesSection, ServicesSection } from './CatalogSections';
import { SettingsSection } from './SettingsSection';
import { Notice, Panel, useAdminSnapshot } from './common';

export function AdminSections({ section }: { section: AdminSection }) {
  const { snapshot, error, loading, reload } = useAdminSnapshot();
  if (loading) return <Panel><p role="status">Загружаем данные…</p></Panel>;
  if (!snapshot) return <Notice kind="error">{error || 'Данные недоступны.'} <button type="button" class="admin-inline-link" onClick={() => void reload()}>Повторить</button></Notice>;
  return <>
    {error && <Notice kind="error">{error} <button type="button" class="admin-inline-link" onClick={() => void reload()}>Повторить</button></Notice>}
    {section === 'bookings' && <BookingsSection snapshot={snapshot} reload={reload} />}
    {section === 'services' && <ServicesSection snapshot={snapshot} reload={reload} />}
    {section === 'categories' && <CategoriesSection snapshot={snapshot} reload={reload} />}
    {section === 'settings' && <SettingsSection snapshot={snapshot} reload={reload} />}
  </>;
}

export function renderAdminSection(section: AdminSection) { return <AdminSections section={section} />; }
