import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { auth, demoMode } from '../data/runtime';
import { adminRouteFromHash, adminRouteHref, adminSections, type AdminSection } from './navigation';

export type AdminAppProps = {
  renderSection?: (section: AdminSection) => ComponentChildren;
};

export function AdminApp({ renderSection }: AdminAppProps) {
  const [section, setSection] = useState<AdminSection>(() => adminRouteFromHash(window.location.hash));
  const [staff, setStaff] = useState<{ id: string; login: string } | null>(null);
  const [checkingSession, setCheckingSession] = useState(!demoMode);
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const hasMounted = useRef(false);
  const current = adminSections.find(item => item.id === section)!;

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
    const updateRoute = () => setSection(adminRouteFromHash(window.location.hash));
    window.addEventListener('hashchange', updateRoute);
    return () => window.removeEventListener('hashchange', updateRoute);
  }, []);

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
          <span class="brand-copy"><strong>АВТОСПЕКТР</strong><small>ПАНЕЛЬ УПРАВЛЕНИЯ</small></span>
        </a>
        <div class="admin-header-session">
          <span class="admin-header-caption">{staff ? `Сотрудник: ${staff.login}` : 'Рабочее место оператора'}</span>
          {staff && <button type="button" class="admin-logout" onClick={() => void signOut()} disabled={authBusy}>Выйти</button>}
        </div>
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
            {authError && <p class="admin-auth-error" role="alert">{authError}</p>}
            {renderSection ? renderSection(section) : <div class="admin-empty-state" role="status">Раздел готовится к работе.</div>}
          </div>
        </main>
      </div>
    </div>
  );
}
