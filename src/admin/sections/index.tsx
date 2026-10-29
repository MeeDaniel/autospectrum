import type { AdminSection } from '../navigation';
import { BookingsSection } from './BookingsSection';
import { CategoriesSection, ServicesSection } from './CatalogSections';
import { SettingsSection } from './SettingsSection';
import { Notice, Panel, useAdminSnapshot } from './common';
import { AuditSection } from './AuditSection';
import { StaffSection } from './StaffSection';

export function AdminSections({ section, actorId }: { section: AdminSection; actorId?: string }) {
  if (section === 'audit') return <AuditSection />;
  if (section === 'staff') return <StaffSection actorId={actorId} />;
  return <SnapshotSections section={section} />;
}

function SnapshotSections({ section }: { section: Exclude<AdminSection, 'audit' | 'staff'> }) {
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

export function renderAdminSection(section: AdminSection, actorId?: string) { return <AdminSections section={section} actorId={actorId} />; }
