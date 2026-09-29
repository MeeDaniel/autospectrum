import { useEffect, useRef, useState } from 'preact/hooks';
import { adminProvider, ScheduleConflictError } from '../../data/demo';
import type { AdminCategory, AdminService, AdminSnapshot, CategoryInput, ServiceInput } from '../../domain/admin';
import { impactedBookings } from './section-model';
import { ActionBar, Field, Notice, Panel, confirmDiscard, isDirty, messageOf, useModalFocus, useUnsavedChanges } from './common';

type CommonProps = { snapshot: AdminSnapshot; reload: () => Promise<void> };

export function ServicesSection({ snapshot, reload }: CommonProps) {
  const [selected, setSelected] = useState<AdminService | 'new' | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const perform = async (operation: () => Promise<unknown>, success: string) => {
    setBusy(true); setError(''); setMessage('');
    try { await operation(); await reload(); setSelected(null); setMessage(success); return true; }
    catch (cause) { if (cause instanceof ScheduleConflictError) await reload(); setError(messageOf(cause)); return false; }
    finally { setBusy(false); }
  };
  const remove = (item: AdminService) => {
    if (snapshot.bookings.some(booking => booking.serviceId === item.id)) {
      void perform(() => adminProvider.setServiceArchived(item.id, item.revision, true), 'Услуга перенесена в архив.'); return;
    }
    if (window.confirm(`Удалить услугу «${item.name}» окончательно?`)) void perform(() => adminProvider.deleteService(item.id, item.revision), 'Услуга удалена.');
  };
  return <div class="admin-stack">
    {error && <Notice kind="error">{error}</Notice>}{message && <Notice kind="success">{message}</Notice>}
    <Panel><div class="admin-section-top"><div><h2>Услуги</h2><p>Укажите цену от и ожидаемое время работы.</p></div><button class="button primary" type="button" onClick={() => setSelected('new')}>+ Добавить услугу</button></div><label class="admin-checkbox"><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.currentTarget.checked)} /> Показать архивные услуги</label></Panel>
    <div class="admin-catalog-grid">{snapshot.services.filter(item => showArchived || !item.archived).map(item => {
      const category = snapshot.categories.find(value => value.id === item.categoryId);
      const used = snapshot.bookings.filter(booking => booking.serviceId === item.id).length;
      return <Panel key={item.id} className="admin-catalog-item"><div class="admin-catalog-head"><span class="admin-kicker">{category?.name ?? 'Без категории'}</span>{item.archived && <span class="admin-archived">Архив</span>}</div><h3>{item.name}</h3><p class="admin-catalog-meta">от {item.priceFrom.toLocaleString('ru-RU')} ₽ <span>·</span> {item.durationMinutes} мин</p><p class="admin-muted">Записей: {used}</p><div class="admin-item-actions"><button class="admin-text-button" type="button" onClick={() => setSelected(item)}>Изменить</button><button class="admin-text-button" type="button" disabled={busy} onClick={() => void perform(() => adminProvider.setServiceArchived(item.id, item.revision, !item.archived), item.archived ? 'Услуга восстановлена.' : 'Услуга перенесена в архив.')}>{item.archived ? 'Восстановить' : 'В архив'}</button><button class="admin-danger" type="button" disabled={busy || used > 0} title={used ? 'Услуга используется в записях; её можно архивировать' : undefined} onClick={() => remove(item)}>Удалить</button></div></Panel>;
    })}</div>
    {selected && <ServiceEditor key={selected === 'new' ? 'new' : selected.id} snapshot={snapshot} initial={selected === 'new' ? { name: '', priceFrom: 0, durationMinutes: 30, categoryId: snapshot.categories.find(item => !item.archived)?.id ?? '' } : selected} onClose={() => setSelected(null)} onRefresh={async () => { await reload(); setSelected(null); }} onSave={async (draft, allow) => { if (allow && JSON.stringify(await adminProvider.getSnapshot()) !== JSON.stringify(snapshot)) { await reload(); setError('Данные изменились. Проверьте конфликты и подтвердите повторно.'); return false; } return perform(() => adminProvider.saveService(draft, allow), 'Услуга сохранена.'); }} error={error} onError={setError} />}
  </div>;
}

function ServiceEditor({ snapshot, initial, onClose, onRefresh, onSave, error, onError }: { snapshot: AdminSnapshot; initial: ServiceInput; onClose: () => void; onRefresh: () => Promise<void>; onSave: (draft: ServiceInput, allow: boolean) => Promise<boolean>; error: string; onError: (value: string) => void }) {
  const [draft, setDraft] = useState<ServiceInput>({ ...initial });
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [ack, setAck] = useState(false);
  const [validation, setValidation] = useState('');
  const dirty = isDirty(initial, draft);
  const dialog = useModalFocus(() => { if (confirmDiscard(dirty)) onClose(); });
  useUnsavedChanges(dirty);
  useEffect(() => setAck(false), [draft]);
  useEffect(() => setAck(false), [snapshot]);
  const proposed: AdminSnapshot = { ...snapshot, services: draft.id ? snapshot.services.map(item => item.id === draft.id ? { ...item, ...draft } : item) : snapshot.services };
  const impacted = impactedBookings(snapshot, proposed);
  const save = async (event: Event) => {
    event.preventDefault(); setValidation(''); onError('');
    if (savingRef.current) return;
    if (!draft.name.trim() || !draft.categoryId || !Number.isFinite(draft.priceFrom) || draft.priceFrom < 0 || !Number.isInteger(draft.durationMinutes) || draft.durationMinutes < 1 || draft.durationMinutes > 1439) { setValidation('Проверьте название, категорию, цену и длительность.'); return; }
    if (impacted.length && !ack) { setValidation('Подтвердите сохранение с конфликтами.'); return; }
    savingRef.current = true; setSaving(true);
    try { if (!await onSave({ ...draft, name: draft.name.trim() }, ack)) setAck(false); }
    finally { savingRef.current = false; setSaving(false); }
  };
  return <div class="admin-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && confirmDiscard(dirty)) onClose(); }}><section ref={dialog} class="admin-editor" role="dialog" aria-modal="true" aria-label={draft.id ? 'Редактирование услуги' : 'Новая услуга'}><header class="admin-editor-head"><div><p class="eyebrow">ПРАЙС</p><h2>{draft.id ? 'Изменить услугу' : 'Новая услуга'}</h2></div><button class="admin-close" type="button" aria-label="Закрыть" onClick={() => { if (confirmDiscard(dirty)) onClose(); }}>×</button></header><form class="admin-editor-body" onSubmit={save}><div class="admin-form-grid">
    <Field label="Название"><input required value={draft.name} onInput={event => setDraft({ ...draft, name: event.currentTarget.value })} /></Field>
    <Field label="Категория"><select required value={draft.categoryId} onChange={event => setDraft({ ...draft, categoryId: event.currentTarget.value })}><option value="">Выберите категорию</option>{snapshot.categories.filter(item => !item.archived || item.id === initial.categoryId).map(item => <option key={item.id} value={item.id}>{item.name}{item.archived ? ' (архив)' : ''}</option>)}</select></Field>
    <Field label="Стартовая цена, ₽"><input type="number" min="0" step="1" required value={draft.priceFrom} onInput={event => setDraft({ ...draft, priceFrom: Number(event.currentTarget.value) })} /></Field>
    <Field label="Примерное время, мин"><input type="number" min="1" max="1439" step="1" required value={draft.durationMinutes} onInput={event => setDraft({ ...draft, durationMinutes: Number(event.currentTarget.value) })} /></Field>
    </div>{impacted.length > 0 && <ImpactWarning impacted={impacted} ack={ack} setAck={setAck} />}{validation && <Notice kind="error">{validation}</Notice>}{error && <Notice kind="error">{error} <button type="button" class="admin-inline-link" onClick={() => void onRefresh()}>Закрыть и загрузить актуальную версию</button></Notice>}<ActionBar><button type="button" class="button secondary" onClick={() => { if (confirmDiscard(dirty)) onClose(); }}>Отмена</button><button type="submit" class="button primary" disabled={saving}>{saving ? 'Сохраняем…' : 'Сохранить услугу'}</button></ActionBar></form></section></div>;
}

export function CategoriesSection({ snapshot, reload }: CommonProps) {
  const [selected, setSelected] = useState<AdminCategory | 'new' | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const perform = async (operation: () => Promise<unknown>, success: string) => {
    setBusy(true); setError(''); setMessage('');
    try { await operation(); await reload(); setSelected(null); setMessage(success); return true; }
    catch (cause) { if (cause instanceof ScheduleConflictError) await reload(); setError(messageOf(cause)); return false; }
    finally { setBusy(false); }
  };
  return <div class="admin-stack">
    {error && <Notice kind="error">{error}</Notice>}{message && <Notice kind="success">{message}</Notice>}
    <Panel><div class="admin-section-top"><div><h2>Категории</h2><p>Количество линий задаёт допустимое число одновременных записей.</p></div><button class="button primary" type="button" onClick={() => setSelected('new')}>+ Добавить категорию</button></div><label class="admin-checkbox"><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.currentTarget.checked)} /> Показать архивные категории</label></Panel>
    <div class="admin-catalog-grid">{snapshot.categories.filter(item => showArchived || !item.archived).map(item => {
      const services = snapshot.services.filter(value => value.categoryId === item.id);
      return <Panel key={item.id} className="admin-catalog-item"><div class="admin-catalog-head"><span class="admin-kicker">НАПРАВЛЕНИЕ</span>{item.archived && <span class="admin-archived">Архив</span>}</div><h3>{item.name}</h3><p class="admin-catalog-meta">{item.lineCount} {item.lineCount === 1 ? 'линия' : 'линий'}</p><p class="admin-muted">Услуг: {services.length}</p><div class="admin-item-actions"><button class="admin-text-button" type="button" onClick={() => setSelected(item)}>Изменить</button><button class="admin-text-button" type="button" disabled={busy} onClick={() => void perform(() => adminProvider.setCategoryArchived(item.id, item.revision, !item.archived), item.archived ? 'Категория восстановлена.' : 'Категория перенесена в архив.')}>{item.archived ? 'Восстановить' : 'В архив'}</button><button class="admin-danger" type="button" disabled={busy || services.length > 0} title={services.length ? 'Категория используется в услугах; её можно архивировать' : undefined} onClick={() => { if (window.confirm(`Удалить категорию «${item.name}» окончательно?`)) void perform(() => adminProvider.deleteCategory(item.id, item.revision), 'Категория удалена.'); }}>Удалить</button></div></Panel>;
    })}</div>
    {selected && <CategoryEditor key={selected === 'new' ? 'new' : selected.id} snapshot={snapshot} initial={selected === 'new' ? { name: '', lineCount: 1 } : selected} onClose={() => setSelected(null)} onRefresh={async () => { await reload(); setSelected(null); }} onSave={async (draft, allow) => { if (allow && JSON.stringify(await adminProvider.getSnapshot()) !== JSON.stringify(snapshot)) { await reload(); setError('Данные изменились. Проверьте конфликты и подтвердите повторно.'); return false; } return perform(() => adminProvider.saveCategory(draft, allow), 'Категория сохранена.'); }} error={error} onError={setError} />}
  </div>;
}

function CategoryEditor({ snapshot, initial, onClose, onRefresh, onSave, error, onError }: { snapshot: AdminSnapshot; initial: CategoryInput; onClose: () => void; onRefresh: () => Promise<void>; onSave: (draft: CategoryInput, allow: boolean) => Promise<boolean>; error: string; onError: (value: string) => void }) {
  const [draft, setDraft] = useState<CategoryInput>({ ...initial });
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [ack, setAck] = useState(false);
  const [validation, setValidation] = useState('');
  const dirty = isDirty(initial, draft);
  const dialog = useModalFocus(() => { if (confirmDiscard(dirty)) onClose(); });
  useUnsavedChanges(dirty);
  useEffect(() => setAck(false), [draft]);
  useEffect(() => setAck(false), [snapshot]);
  const proposed: AdminSnapshot = { ...snapshot, categories: draft.id ? snapshot.categories.map(item => item.id === draft.id ? { ...item, ...draft } : item) : snapshot.categories };
  const impacted = impactedBookings(snapshot, proposed);
  const save = async (event: Event) => {
    event.preventDefault(); setValidation(''); onError('');
    if (savingRef.current) return;
    if (!draft.name.trim() || !Number.isInteger(draft.lineCount) || draft.lineCount < 0) { setValidation('Укажите название и целое неотрицательное количество линий.'); return; }
    if (impacted.length && !ack) { setValidation('Подтвердите сохранение с конфликтами.'); return; }
    savingRef.current = true; setSaving(true);
    try { if (!await onSave({ ...draft, name: draft.name.trim() }, ack)) setAck(false); }
    finally { savingRef.current = false; setSaving(false); }
  };
  return <div class="admin-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && confirmDiscard(dirty)) onClose(); }}><section ref={dialog} class="admin-editor" role="dialog" aria-modal="true" aria-label={draft.id ? 'Редактирование категории' : 'Новая категория'}><header class="admin-editor-head"><div><p class="eyebrow">РАБОЧИЕ ЛИНИИ</p><h2>{draft.id ? 'Изменить категорию' : 'Новая категория'}</h2></div><button class="admin-close" type="button" aria-label="Закрыть" onClick={() => { if (confirmDiscard(dirty)) onClose(); }}>×</button></header><form class="admin-editor-body" onSubmit={save}><div class="admin-form-grid">
    <Field label="Название"><input required value={draft.name} onInput={event => setDraft({ ...draft, name: event.currentTarget.value })} /></Field>
    <Field label="Количество линий"><input type="number" min="0" step="1" required value={draft.lineCount} onInput={event => setDraft({ ...draft, lineCount: Number(event.currentTarget.value) })} /></Field>
    </div>{impacted.length > 0 && <ImpactWarning impacted={impacted} ack={ack} setAck={setAck} />}{validation && <Notice kind="error">{validation}</Notice>}{error && <Notice kind="error">{error} <button type="button" class="admin-inline-link" onClick={() => void onRefresh()}>Закрыть и загрузить актуальную версию</button></Notice>}<ActionBar><button type="button" class="button secondary" onClick={() => { if (confirmDiscard(dirty)) onClose(); }}>Отмена</button><button type="submit" class="button primary" disabled={saving}>{saving ? 'Сохраняем…' : 'Сохранить категорию'}</button></ActionBar></form></section></div>;
}

export function ImpactWarning({ impacted, ack, setAck }: { impacted: { id: string; name: string; date: string; startMinute: number }[]; ack: boolean; setAck: (value: boolean) => void }) {
  return <div class="admin-impact"><strong>Изменение затронет {impacted.length} записей</strong><ul>{impacted.map(item => <li key={item.id}>{item.date}, {item.name} — {String(Math.floor(item.startMinute / 60)).padStart(2, '0')}:{String(item.startMinute % 60).padStart(2, '0')}</li>)}</ul><label class="admin-checkbox"><input type="checkbox" checked={ack} onChange={event => setAck(event.currentTarget.checked)} /> Сохранить с конфликтами расписания</label></div>;
}
