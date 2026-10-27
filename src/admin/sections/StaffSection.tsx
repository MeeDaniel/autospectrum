import { useEffect, useState } from 'preact/hooks';
import { demoMode, staffManagement } from '../../data/runtime';
import type { StaffAccount, StaffRole } from '../../domain/staff';
import { Notice, Panel, messageOf } from './common';

export function StaffSection({ actorId }: { actorId?: string }) {
  const [accounts, setAccounts] = useState<StaffAccount[]>([]);
  const [loading, setLoading] = useState(!demoMode);
  const [busy, setBusy] = useState(false);
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<StaffRole>('staff');
  const [resetId, setResetId] = useState<string | null>(null);
  const [replacement, setReplacement] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const reload = async () => {
    setLoading(true);
    try { setAccounts(await staffManagement.list()); setError(''); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setLoading(false); }
  };
  useEffect(() => { if (!demoMode) void reload(); }, []);

  const perform = async (work: () => Promise<unknown>, success: string): Promise<boolean> => {
    setBusy(true); setError(''); setNotice('');
    try { await work(); await reload(); setNotice(success); return true; }
    catch (cause) { setError(messageOf(cause)); return false; }
    finally { setBusy(false); }
  };
  const create = async (event: Event) => {
    event.preventDefault();
    if (await perform(() => staffManagement.create({ login, password, role }), 'Сотрудник создан.')) {
      setLogin(''); setPassword(''); setRole('staff');
    }
  };
  const resetPassword = async (event: Event, account: StaffAccount) => {
    event.preventDefault();
    if (await perform(() => staffManagement.resetPassword(account.id, replacement), 'Пароль изменён. Старые сессии закрыты.')) {
      setReplacement(''); setResetId(null);
    }
  };

  if (demoMode) return <Panel><p class="admin-muted">Управление сотрудниками доступно только при подключении к серверу.</p></Panel>;

  return <div class="admin-stack">
    <Panel>
      <div class="admin-section-top"><div><h2>Новый сотрудник</h2><p>После создания сотрудник сможет войти с указанным паролем.</p></div></div>
      <form class="admin-form-grid" onSubmit={event => void create(event)}>
        <label class="admin-field"><span>Логин</span><input autoComplete="off" value={login} onInput={event => setLogin(event.currentTarget.value)} pattern="[A-Za-z0-9._@-]{3,64}" required /></label>
        <label class="admin-field"><span>Роль</span><select value={role} onChange={event => setRole(event.currentTarget.value as StaffRole)} required><option value="staff">Сотрудник</option><option value="operator">Оператор</option></select></label>
        <label class="admin-field"><span>Пароль</span><input type="password" autoComplete="new-password" minLength={12} maxLength={1024} value={password} onInput={event => setPassword(event.currentTarget.value)} required /></label>
        <button type="submit" class="button" disabled={busy}>Создать</button>
      </form>
    </Panel>
    {error && <Notice kind="error">{error}</Notice>}
    {notice && <Notice kind="success">{notice}</Notice>}
    <section class="admin-panel admin-list-panel">
      <div class="admin-section-top admin-staff-list-head"><div><h2>Учётные записи</h2><p>Роль и состояние можно изменить без удаления истории.</p></div><button type="button" class="admin-text-button" onClick={() => void reload()} disabled={loading || busy}>Обновить</button></div>
      {loading ? <p class="admin-empty" role="status">Загружаем сотрудников…</p> : accounts.length === 0 ? <p class="admin-empty">Сотрудников пока нет.</p> :
        <div class="admin-table-scroll"><table class="admin-table"><thead><tr><th>Логин</th><th>Роль</th><th>Состояние</th><th>Действия</th></tr></thead><tbody>
          {accounts.map(account => <tr key={account.id}>
            <td data-label="Логин"><strong>{account.login}</strong></td>
            <td data-label="Роль"><select aria-label={`Роль ${account.login}`} value={account.role} disabled={busy || account.id === actorId} onChange={event => void perform(() => staffManagement.update(account.id, { role: event.currentTarget.value as StaffRole }), 'Роль изменена. Старые сессии закрыты.')}><option value="staff">Сотрудник</option><option value="operator">Оператор</option></select></td>
            <td data-label="Состояние">{account.blocked ? 'Заблокирован' : 'Активен'}</td>
            <td data-label="Действия"><div class="admin-staff-actions">
              <button type="button" class="admin-text-button" disabled={busy || (account.id === actorId && !account.blocked)} onClick={() => void perform(() => staffManagement.update(account.id, { blocked: !account.blocked }), account.blocked ? 'Сотрудник разблокирован.' : 'Сотрудник заблокирован. Старые сессии закрыты.')}>{account.blocked ? 'Разблокировать' : 'Заблокировать'}</button>
              <button type="button" class="admin-text-button" disabled={busy} onClick={() => { setResetId(account.id); setReplacement(''); }}>Сменить пароль</button>
            </div>{resetId === account.id && <form class="admin-staff-reset" onSubmit={event => void resetPassword(event, account)}><label class="admin-field"><span>Новый пароль</span><input type="password" autoComplete="new-password" minLength={12} maxLength={1024} value={replacement} onInput={event => setReplacement(event.currentTarget.value)} required /></label><button type="submit" class="button" disabled={busy}>Сохранить</button><button type="button" class="admin-text-button" onClick={() => { setResetId(null); setReplacement(''); }}>Отмена</button></form>}</td>
          </tr>)}
        </tbody></table></div>}
    </section>
  </div>;
}
