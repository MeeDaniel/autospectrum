import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { auth, demoMode } from '../data/runtime';
import { adminRouteFromHash, adminRouteHref, adminSections, allowedAdminSection, visibleAdminSections, type AdminSection } from './navigation';
import type { StaffRole } from '../domain/staff';
import { DirtyNavigationContext, type RegisterDirtyEditor } from './dirty-navigation';

export type AdminAppProps = {
  renderSection?: (section: AdminSection, actorId?: string) => ComponentChildren;
};

export function AdminApp({ renderSection }: AdminAppProps) {
  const [section, setSection] = useState<AdminSection>(() => adminRouteFromHash(window.location.hash));
  const [staff, setStaff] = useState<{ id: string; login: string; role: StaffRole } | null>(null);
  const [checkingSession, setCheckingSession] = useState(!demoMode);
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const hasMounted = useRef(false);
  const dirtyEditors = useRef(new Set<() => boolean>());
  const acceptedRoute = useRef({ section, url: window.location.href });
  const registerDirtyEditor = useRef<RegisterDirtyEditor>(predicate => {
    dirtyEditors.current.add(predicate);
    return () => { dirtyEditors.current.delete(predicate); };
  }).current;
  const activeSection = allowedAdminSection(section, staff?.role ?? null, demoMode);
  const current = adminSections.find(item => item.id === activeSection)!;

  const transition = (requested: AdminSection, urlChanged: boolean) => {
    const next = allowedAdminSection(requested, staff?.role ?? null, demoMode);
    const targetUrl = new URL(adminRouteHref(next), window.location.href).href;
    if (!urlChanged && next === acceptedRoute.current.section) return;
    if (next !== acceptedRoute.current.section && Array.from(dirtyEditors.current).some(isDirty => isDirty())) {
      if (!window.confirm('Есть несохранённые изменения. Покинуть раздел?')) {
        if (urlChanged) window.history.replaceState(window.history.state, '', acceptedRoute.current.url);
        return;
      }
    }
    if (!urlChanged) window.history.pushState(window.history.state, '', targetUrl);
    else if (window.location.href !== targetUrl) window.history.replaceState(window.history.state, '', targetUrl);
    acceptedRoute.current = { section: next, url: targetUrl };
    setSection(next);
  };

  useEffect(() => {
    if (demoMode) return;
    return auth.onUnauthorized(() => { setStaff(null); setPassword(''); });
  }, []);

  useEffect(() => {
    if (!demoMode && !staff) return;
    const next = allowedAdminSection(adminRouteFromHash(window.location.hash), staff?.role ?? null, demoMode);
    if (adminRouteFromHash(window.location.hash) !== next) window.history.replaceState(null, '', adminRouteHref(next));
    acceptedRoute.current = { section: next, url: window.location.href };
    setSection(next);
  }, [staff?.role]);

  useEffect(() => {
    if (demoMode) return;
    let active = true;
    void auth.currentSession().then(session => {
      if (active) setStaff(session.staff);
    }).catch(() => {
      if (active) setStaff(null);
    }).finally(() => { if (active) setCheckingSession(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const updateRoute = () => transition(adminRouteFromHash(window.location.hash), true);
    window.addEventListener('hashchange', updateRoute);
    window.addEventListener('popstate', updateRoute);
    return () => { window.removeEventListener('hashchange', updateRoute); window.removeEventListener('popstate', updateRoute); };
  }, [staff?.role]);

  useEffect(() => {
    document.title = `${current.label} — АвтоСпектр`;
    if (hasMounted.current) headingRef.current?.focus();
    else hasMounted.current = true;
  }, [current.label]);

  const signIn = async (event: Event) => {
    event.preventDefault();
    setAuthBusy(true);
    setAuthError('');
    try {
      const session = await auth.login(login, password);
      setPassword('');
      setStaff(session.staff);
    } catch (cause) {
      setAuthError(cause instanceof Error && cause.message.includes('429')
        ? 'Слишком много попыток входа. Попробуйте через 15 минут.'
        : 'Не удалось войти. Проверьте логин и пароль.');
    } finally { setAuthBusy(false); }
  };

  const signOut = async () => {
    setAuthBusy(true);
    setAuthError('');
    try {
      await auth.logout();
      setStaff(null);
      setPassword('');
    } catch {
      setAuthError('Не удалось выйти. Попробуйте ещё раз.');
    } finally { setAuthBusy(false); }
  };

  if (checkingSession) return <div class="admin-auth" role="status">Проверяем доступ…</div>;

  if (!demoMode && !staff) return (
    <main class="admin-auth">
      <form class="admin-auth-card" onSubmit={signIn}>
        <span class="brand-mark" aria-hidden="true" />
        <p class="eyebrow">АВТОСПЕКТР / УПРАВЛЕНИЕ</p>
        <h1>Вход для сотрудников</h1>
        <p>Введите учётные данные, чтобы открыть панель управления.</p>
        <label class="admin-field"><span>Логин</span><input name="login" autoComplete="username" value={login} onInput={event => setLogin(event.currentTarget.value)} required /></label>
        <label class="admin-field"><span>Пароль</span><input name="password" type="password" autoComplete="current-password" value={password} onInput={event => setPassword(event.currentTarget.value)} required /></label>
        {authError && <p class="admin-auth-error" role="alert">{authError}</p>}
        <button class="button" type="submit" disabled={authBusy}>{authBusy ? 'Входим…' : 'Войти'}</button>
      </form>
    </main>
  );

  return (
    <div class="admin-shell">
      <header class="admin-header">
        <a class="brand" href="/" aria-label="АвтоСпектр — клиентский сайт">
          <span class="brand-mark" aria-hidden="true" />
          <span class="brand-copy"></span>
        </a>
        <div class="admin-header-session">
          <span class="admin-header-caption">{staff ? `Сотрудник: ${staff.login}` : 'Рабочее место оператора'}</span>
          {staff && <button type="button" class="admin-logout" onClick={() => void signOut()} disabled={authBusy}>Выйти</button>}
        </div>
      </header>
      <div class="admin-layout">
        <aside class="admin-sidebar" aria-label="Разделы админ-панели">
          <nav class="admin-nav" aria-label="Основная навигация">
            {visibleAdminSections(staff?.role ?? null, demoMode).map(item => (
              <a key={item.id} href={adminRouteHref(item.id)} onClick={event => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); transition(item.id, false); }} class={item.id === activeSection ? 'admin-nav-link is-active' : 'admin-nav-link'} aria-current={item.id === activeSection ? 'page' : undefined}>
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
            {authError && <p class="admin-auth-error" role="alert">{authError}</p>}
            <DirtyNavigationContext.Provider value={registerDirtyEditor}>
              {renderSection ? renderSection(activeSection, staff?.id) : <div class="admin-empty-state" role="status">Раздел готовится к работе.</div>}
            </DirtyNavigationContext.Provider>
          </div>
        </main>
      </div>
    </div>
  );
}
