import { useEffect, useState } from 'preact/hooks';
import { demoMode, listAudit } from '../../data/runtime';

type AuditItem = {
  id: number;
  actor_id: string | null;
  actor_login: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  created_at: string;
};

const actions: Record<string, string> = {
  'auth.login': 'Вход',
  'auth.logout': 'Выход',
  'staff.create': 'Сотрудник создан',
  'staff.block': 'Сотрудник заблокирован',
  'staff.reset_password': 'Пароль сброшен',
  'booking.create': 'Запись создана',
  'booking.update': 'Запись изменена',
  'booking.delete': 'Запись удалена',
  'service.create': 'Услуга создана',
  'service.update': 'Услуга изменена',
  'category.create': 'Категория создана',
  'category.update': 'Категория изменена',
  'settings.update': 'Настройки изменены',
};
const entities: Record<string, string> = { booking: 'Запись', service: 'Услуга', category: 'Категория', settings: 'Настройки', staff: 'Сотрудник' };
const genericActions: Record<string, string> = { create: 'создана', update: 'изменена', delete: 'удалена', archive: 'архивирована', restore: 'восстановлена' };

function actionLabel(item: AuditItem): string {
  if (actions[item.action]) return actions[item.action];
  const entity = entities[item.entity];
  const action = genericActions[item.action];
  return entity && action ? `${entity} ${action}` : item.action;
}

function isAuditItem(value: unknown): value is AuditItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'number' && typeof item.action === 'string' && typeof item.entity === 'string' && typeof item.created_at === 'string';
}

function displayTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'medium', timeStyle: 'short' });
}

export function AuditSection() {
  const [entity, setEntity] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [entries, setEntries] = useState<AuditItem[]>([]);
  const [loading, setLoading] = useState(!demoMode);
  const [error, setError] = useState('');

  useEffect(() => {
    if (demoMode) return;
    let active = true;
    setLoading(true);
    setError('');
    setEntries([]);
    void listAudit({ ...(entity ? { entity } : {}), limit: 100 }).then(rows => {
      if (active) setEntries(rows.filter(isAuditItem));
    }).catch(() => {
      if (active) setError('Не удалось загрузить историю действий.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [entity, refresh]);

  if (demoMode) return <section class="admin-panel"><p class="admin-muted">История действий доступна при подключении к серверу.</p></section>;

  return <div class="admin-stack">
    <section class="admin-panel">
      <div class="admin-section-top"><div><h2>История действий</h2><p>Последние 100 действий сотрудников.</p></div>
        <button type="button" class="admin-text-button" onClick={() => setRefresh(value => value + 1)} disabled={loading}>Обновить</button>
      </div>
      <label class="admin-field admin-audit-filter"><span>Раздел</span>
        <select value={entity} onChange={event => setEntity(event.currentTarget.value)}>
          <option value="">Все разделы</option><option value="booking">Записи</option><option value="service">Услуги</option>
          <option value="category">Категории</option><option value="settings">Настройки</option><option value="staff">Сотрудники</option>
        </select>
      </label>
    </section>
    {error && <p class="admin-notice error" role="alert">{error}</p>}
    <section class="admin-panel admin-list-panel">
      {loading ? <p class="admin-empty" role="status">Загружаем историю…</p> : entries.length === 0 ? <p class="admin-empty">Действий пока нет.</p> :
        <div class="admin-table-scroll"><table class="admin-table"><thead><tr><th>Время</th><th>Действие</th><th>Сотрудник</th><th>Объект</th></tr></thead><tbody>
          {entries.map(item => <tr key={item.id}>
            <td data-label="Время">{displayTime(item.created_at)}</td>
            <td data-label="Действие"><strong>{actionLabel(item)}</strong></td>
            <td data-label="Сотрудник">{item.actor_login || (item.actor_id ? item.actor_id.slice(0, 8) : 'Система')}</td>
            <td data-label="Объект">{entities[item.entity] ?? item.entity}{item.entity_id ? ` · ${item.entity_id}` : ''}</td>
          </tr>)}
        </tbody></table></div>}
    </section>
  </div>;
}
