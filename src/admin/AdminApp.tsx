import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { adminRouteFromHash, adminRouteHref, adminSections, type AdminSection } from './navigation';

export type AdminAppProps = {
  renderSection?: (section: AdminSection) => ComponentChildren;
};

export function AdminApp({ renderSection }: AdminAppProps) {
  const [section, setSection] = useState<AdminSection>(() => adminRouteFromHash(window.location.hash));
  const headingRef = useRef<HTMLHeadingElement>(null);
  const hasMounted = useRef(false);
  const current = adminSections.find(item => item.id === section)!;

  useEffect(() => {
    const updateRoute = () => setSection(adminRouteFromHash(window.location.hash));
    window.addEventListener('hashchange', updateRoute);
    return () => window.removeEventListener('hashchange', updateRoute);
  }, []);

  useEffect(() => {
    document.title = `${current.label} — АвтоСпектр`;
    if (hasMounted.current) headingRef.current?.focus();
    else hasMounted.current = true;
  }, [current.label]);

  return (
    <div class="admin-shell">
      <header class="admin-header">
        <a class="brand" href="/" aria-label="АвтоСпектр — клиентский сайт">
          <span class="brand-mark" aria-hidden="true" />
          <span class="brand-copy"><strong>АВТОСПЕКТР</strong><small>ПАНЕЛЬ УПРАВЛЕНИЯ</small></span>
        </a>
        <span class="admin-header-caption">Рабочее место оператора</span>
      </header>
      <div class="admin-layout">
        <aside class="admin-sidebar" aria-label="Разделы админ-панели">
          <nav class="admin-nav" aria-label="Основная навигация">
            {adminSections.map(item => (
              <a key={item.id} href={adminRouteHref(item.id)} class={item.id === section ? 'admin-nav-link is-active' : 'admin-nav-link'} aria-current={item.id === section ? 'page' : undefined}>
                <span>{item.label}</span>
                <span aria-hidden="true">↗</span>
              </a>
            ))}
          </nav>
          <div class="admin-sidebar-foot">АвтоСпектр <span>·</span> Управление</div>
        </aside>
        <main class="admin-main" id="main-content">
          <div class="admin-page-heading">
            <p class="eyebrow">АВТОСПЕКТР / УПРАВЛЕНИЕ</p>
            <h1 ref={headingRef} tabIndex={-1}>{current.label}</h1>
            <p>{current.description}</p>
          </div>
          <div class="admin-page-content">
            {renderSection ? renderSection(section) : <div class="admin-empty-state" role="status">Раздел готовится к работе.</div>}
          </div>
        </main>
      </div>
    </div>
  );
}
