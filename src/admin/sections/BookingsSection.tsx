import { useEffect, useMemo, useState } from 'preact/hooks';
import { adminProvider, ScheduleConflictError } from '../../data/demo';
import { assessBooking, parseMinute, validDate, validMinute, type AdminBooking, type AdminSnapshot, type BookingInput, type BookingStatus, type Conflict } from '../../domain/admin';
import { filterBookings, type BookingFilters } from './section-model';
import { ActionBar, ConflictList, Field, Notice, Panel, confirmDiscard, isDirty, messageOf, moscowToday, safeTime, useModalFocus, useUnsavedChanges } from './common';

export const statusLabels: Record<BookingStatus, string> = { new: 'Новая', confirmed: 'Подтверждена', in_progress: 'В работе', completed: 'Выполнена', cancelled: 'Отменена' };
const blankFilters: BookingFilters = { query: '', date: '', status: '', categoryId: '', serviceId: '', conflictsOnly: false };
function blankBooking(snapshot: AdminSnapshot): BookingInput {
  const service = snapshot.services.find(item => !item.archived && !snapshot.categories.find(category => category.id === item.categoryId)?.archived);
  return { serviceId: service?.id ?? '', date: moscowToday(), startMinute: snapshot.settings.workStart, durationMinutes: service?.durationMinutes ?? 30, name: '', phone: '', car: '', comment: '', status: 'new' };
}

export function BookingsSection({ snapshot, reload }: { snapshot: AdminSnapshot; reload: () => Promise<void> }) {
  const [dateFrom, setDateFrom] = useState(moscowToday());
  const [dateTo, setDateTo] = useState(moscowToday());
  const [filters, setFilters] = useState<BookingFilters>(blankFilters);
  const [selectedId, setSelectedId] = useState<string | 'new' | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);
  const filtered = useMemo(() => filterBookings(snapshot, filters).filter(item => (!dateFrom || item.date >= dateFrom) && (!dateTo || item.date <= dateTo)), [snapshot, filters, dateFrom, dateTo]);
  const selected = selectedId && selectedId !== 'new' ? snapshot.bookings.find(item => item.id === selectedId) : undefined;
  const open = (id: string | 'new') => { setError(''); setSuccess(''); setSelectedId(id); };
  const remove = async (booking: AdminBooking) => {
    if (!window.confirm(`Удалить запись ${booking.name} от ${booking.date} окончательно?`)) return;
    setBusy(true); setError('');
    try { await adminProvider.deleteBooking(booking.id, booking.revision); await reload(); setSelectedId(null); setSuccess('Запись удалена.'); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  };

  return <div class="admin-stack">
    {error && <Notice kind="error">{error}</Notice>}{success && <Notice kind="success">{success}</Notice>}
    <Panel>
      <div class="admin-section-top"><div><h2>Все заявки</h2><p>На экране {filtered.length} из {snapshot.bookings.length} записей</p></div><button class="button primary" type="button" onClick={() => open('new')}>+ Новая запись</button></div>
      <div class="admin-filters">
        <Field label="Поиск"><input type="search" value={filters.query} placeholder="Имя, телефон или автомобиль" onInput={event => setFilters({ ...filters, query: event.currentTarget.value })} /></Field>
        <Field label="С даты"><input type="date" value={dateFrom} onInput={event => setDateFrom(event.currentTarget.value)} /></Field>
        <Field label="По дату"><input type="date" value={dateTo} onInput={event => setDateTo(event.currentTarget.value)} /></Field>
        <Field label="Статус"><select value={filters.status} onChange={event => setFilters({ ...filters, status: event.currentTarget.value as BookingStatus | '' })}><option value="">Все статусы</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
        <Field label="Категория"><select value={filters.categoryId} onChange={event => setFilters({ ...filters, categoryId: event.currentTarget.value })}><option value="">Все категории</option>{snapshot.categories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
        <Field label="Услуга"><select value={filters.serviceId} onChange={event => setFilters({ ...filters, serviceId: event.currentTarget.value })}><option value="">Все услуги</option>{snapshot.services.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
      </div>
      <div class="admin-filter-extras"><button type="button" class="admin-text-button" onClick={() => { setDateFrom(moscowToday()); setDateTo(moscowToday()); }}>Сегодня</button><button type="button" class="admin-text-button" onClick={() => { setDateFrom(''); setDateTo(''); }}>За всё время</button><label class="admin-checkbox"><input type="checkbox" checked={filters.conflictsOnly} onChange={event => setFilters({ ...filters, conflictsOnly: event.currentTarget.checked })} /> Только конфликты</label></div>
    </Panel>
    <Panel className="admin-list-panel">
      {filtered.length === 0 ? <div class="admin-empty">По выбранным условиям записей нет.</div> : <div class="admin-table-scroll"><table class="admin-table"><thead><tr><th>Дата и время</th><th>Клиент</th><th>Услуга</th><th>Статус</th><th>Расписание</th><th>Действие</th></tr></thead><tbody>{filtered.map(booking => {
        const service = snapshot.services.find(item => item.id === booking.serviceId);
        const category = snapshot.categories.find(item => item.id === service?.categoryId);
        const conflicts = assessBooking(booking, snapshot);
        return <tr key={booking.id}><td class="admin-cell-stacked" data-label="Дата и время"><strong>{booking.date}</strong><span>{safeTime(booking.startMinute)} · {booking.durationMinutes} мин</span></td><td class="admin-cell-stacked" data-label="Клиент"><strong>{booking.name}</strong><a href={`tel:${booking.phone}`}>{booking.phone}</a><span>{booking.car}</span></td><td class="admin-cell-stacked" data-label="Услуга"><strong>{service?.name ?? 'Удалена'}</strong><span>{category?.name ?? 'Без категории'}</span></td><td data-label="Статус"><span class={`admin-status status-${booking.status}`}>{statusLabels[booking.status]}</span></td><td data-label="Расписание">{conflicts.length ? <span class="admin-warning-count">⚠ {conflicts.length} конфликт(а)</span> : <span class="admin-ok">Без конфликтов</span>}</td><td data-label="Действие"><button class="admin-text-button" type="button" onClick={() => open(booking.id)}>Открыть →</button></td></tr>;
      })}</tbody></table></div>}
    </Panel>
    {selectedId && (selectedId === 'new' || selected) && <BookingEditor key={selectedId} snapshot={snapshot} initial={selected ?? blankBooking(snapshot)} isNew={selectedId === 'new'} busy={busy} setBusy={setBusy} error={error} onClose={() => setSelectedId(null)} onReload={reload} onRefresh={async () => { await reload(); setSelectedId(null); }} onDelete={selected ? () => void remove(selected) : undefined} onSaved={async () => { await reload(); setSelectedId(null); setSuccess('Запись сохранена.'); }} onOpenConflict={id => setSelectedId(id)} onError={setError} />}
  </div>;
}

function BookingEditor({ snapshot, initial, isNew, busy, setBusy, error, onClose, onReload, onRefresh, onDelete, onSaved, onOpenConflict, onError }: {
  snapshot: AdminSnapshot; initial: BookingInput; isNew: boolean; busy: boolean; setBusy: (value: boolean) => void; error: string;
  onClose: () => void; onReload: () => Promise<void>; onRefresh: () => Promise<void>; onDelete?: () => void; onSaved: () => Promise<void>; onOpenConflict: (id: string) => void; onError: (value: string) => void;
}) {
  const [draft, setDraft] = useState<BookingInput>({ ...initial });
  const [time, setTime] = useState(safeTime(initial.startMinute));
  const [acknowledged, setAcknowledged] = useState(false);
  const [serverConflicts, setServerConflicts] = useState<Conflict[] | null>(null);
  const [validation, setValidation] = useState('');
  const dirty = isDirty(initial, draft) || time !== safeTime(initial.startMinute);
  const dialog = useModalFocus(() => { if (confirmDiscard(dirty)) onClose(); });
  useUnsavedChanges(dirty);
  const parsedTime = (() => { try { return parseMinute(time); } catch { return -1; } })();
  const preview = parsedTime >= 0 && draft.serviceId && validDate(draft.date) && draft.durationMinutes > 0 ? assessBooking({ ...draft, startMinute: parsedTime }, snapshot) : [];
  const conflicts = serverConflicts ?? preview;
  useEffect(() => { setAcknowledged(false); setServerConflicts(null); }, [draft, time]);
  useEffect(() => { setAcknowledged(false); }, [snapshot]);
  const validServices = snapshot.services.filter(item => (!item.archived && !snapshot.categories.find(category => category.id === item.categoryId)?.archived) || item.id === initial.serviceId);
  const save = async (event: Event) => {
    event.preventDefault(); onError(''); setValidation('');
    if (!draft.serviceId || !validDate(draft.date) || !validMinute(parsedTime) || !Number.isInteger(draft.durationMinutes) || draft.durationMinutes <= 0 || parsedTime + draft.durationMinutes > 1439 || !draft.name.trim() || !draft.phone.trim() || !draft.car.trim()) {
      setValidation('Заполните услугу, дату, время, длительность, имя, телефон и автомобиль. Конец записи должен находиться в пределах суток.'); return;
    }
    if (conflicts.length && !acknowledged) { setValidation('Проверьте конфликты и подтвердите сохранение.'); return; }
    setBusy(true);
    try {
      const candidate = { ...draft, startMinute: parsedTime, name: draft.name.trim(), phone: draft.phone.trim(), car: draft.car.trim(), comment: draft.comment.trim() };
      if (acknowledged) {
        const fresh = await adminProvider.getSnapshot();
        const current = assessBooking(candidate, fresh);
        const key = (item: Conflict) => `${item.kind}:${item.start}:${item.end}:${item.bookingIds.join(',')}`;
        const reviewed = new Set(conflicts.map(key));
        if (current.some(item => !reviewed.has(key(item)))) {
          setServerConflicts(current); setAcknowledged(false);
          setValidation('Появились новые конфликты. Проверьте их и подтвердите повторно.');
          await onReload(); return;
        }
      }
      await adminProvider.saveBooking(candidate, acknowledged); await onSaved();
    }
    catch (cause) {
      if (cause instanceof ScheduleConflictError) {
        setServerConflicts(cause.conflicts);
        setAcknowledged(false);
        await onReload();
      }
      onError(messageOf(cause));
    }
    finally { setBusy(false); }
  };
  return <div class="admin-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && confirmDiscard(dirty)) onClose(); }}><section ref={dialog} class="admin-editor" role="dialog" aria-modal="true" aria-label={isNew ? 'Новая запись' : 'Редактирование записи'}>
    <header class="admin-editor-head"><div><p class="eyebrow">РАБОТА С ЗАЯВКОЙ</p><h2>{isNew ? 'Новая запись' : `Запись ${draft.name}`}</h2></div><button class="admin-close" type="button" aria-label="Закрыть" onClick={() => { if (confirmDiscard(dirty)) onClose(); }}>×</button></header>
    <form onSubmit={save} class="admin-editor-body"><div class="admin-form-grid">
      <Field label="Услуга"><select required value={draft.serviceId} onChange={event => { const service = snapshot.services.find(item => item.id === event.currentTarget.value); setDraft({ ...draft, serviceId: event.currentTarget.value, durationMinutes: service?.durationMinutes ?? draft.durationMinutes }); }}><option value="">Выберите услугу</option>{validServices.map(item => <option key={item.id} value={item.id}>{item.name}{item.archived ? ' (архив)' : ''}</option>)}</select></Field>
      <Field label="Статус"><select value={draft.status} onChange={event => setDraft({ ...draft, status: event.currentTarget.value as BookingStatus })}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
      <Field label="Дата"><input type="date" required value={draft.date} onInput={event => setDraft({ ...draft, date: event.currentTarget.value })} /></Field>
      <Field label="Время"><input type="time" required step="60" value={time} onInput={event => setTime(event.currentTarget.value)} /></Field>
      <Field label="Длительность, мин"><input type="number" min="1" max="1439" step="1" required value={draft.durationMinutes} onInput={event => setDraft({ ...draft, durationMinutes: Number(event.currentTarget.value) })} /></Field>
      <Field label="Имя клиента"><input required value={draft.name} onInput={event => setDraft({ ...draft, name: event.currentTarget.value })} /></Field>
      <Field label="Телефон"><input type="tel" required value={draft.phone} onInput={event => setDraft({ ...draft, phone: event.currentTarget.value })} /></Field>
      <Field label="Автомобиль"><input required value={draft.car} onInput={event => setDraft({ ...draft, car: event.currentTarget.value })} /></Field>
      <div class="admin-full"><Field label="Комментарий"><textarea rows={3} value={draft.comment} onInput={event => setDraft({ ...draft, comment: event.currentTarget.value })} /></Field></div>
    </div>
    <ConflictList conflicts={conflicts} snapshot={snapshot} onOpen={id => { if (confirmDiscard(dirty)) onOpenConflict(id); }} />
    {conflicts.length > 0 && <label class="admin-checkbox admin-confirm"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.currentTarget.checked)} /> Сохранить несмотря на конфликты</label>}
    {validation && <Notice kind="error">{validation}</Notice>}
    {error && <Notice kind="error">{error} <button class="admin-inline-link" type="button" onClick={() => void onRefresh()}>Закрыть и загрузить актуальную версию</button></Notice>}
    <ActionBar>{onDelete && <button class="admin-danger" type="button" disabled={busy} onClick={onDelete}>Удалить окончательно</button>}<button class="button secondary" type="button" onClick={() => { if (confirmDiscard(dirty)) onClose(); }}>Отмена</button><button class="button primary" type="submit" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить запись'}</button></ActionBar>
    </form>
  </section></div>;
}
