import { useEffect, useMemo, useState } from 'preact/hooks';
import { adminProvider, ScheduleConflictError } from '../../data/runtime';
import { validateSettings, validDate, type AdminSettings, type AdminSnapshot } from '../../domain/admin';
import { impactedBookings } from './section-model';
import { fromSettings, toSettings, type DayDraft, type ScheduleDraft } from './schedule-draft';
import { ImpactWarning } from './CatalogSections';
import { ActionBar, Field, Notice, Panel, isDirty, messageOf, useUnsavedChanges } from './common';

const weekdayNames = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
const freshDay = (): DayDraft => ({ closed: false, start: '09:00', end: '18:00', breaks: [] });

function DayFields({ value, onChange }: { value: DayDraft; onChange: (next: DayDraft) => void }) {
  return <div class="admin-stack">
    <label class="admin-checkbox"><input type="checkbox" checked={value.closed} onChange={event => onChange({ ...value, closed: event.currentTarget.checked })} /> Выходной</label>
    {!value.closed && <>
      <div class="admin-form-grid">
        <Field label="Начало"><input type="time" required value={value.start} onInput={event => onChange({ ...value, start: event.currentTarget.value })} /></Field>
        <Field label="Конец"><input type="time" required value={value.end} onInput={event => onChange({ ...value, end: event.currentTarget.value })} /></Field>
      </div>
      <div class="admin-break-list">{value.breaks.map((pause, index) => <div class="admin-break-row" key={index}>
        <Field label="Перерыв с"><input type="time" required value={pause.start} onInput={event => onChange({ ...value, breaks: value.breaks.map((item, at) => at === index ? { ...item, start: event.currentTarget.value } : item) })} /></Field>
        <Field label="До"><input type="time" required value={pause.end} onInput={event => onChange({ ...value, breaks: value.breaks.map((item, at) => at === index ? { ...item, end: event.currentTarget.value } : item) })} /></Field>
        <button type="button" class="admin-danger" onClick={() => onChange({ ...value, breaks: value.breaks.filter((_, at) => at !== index) })}>Удалить</button>
      </div>)}</div>
      <button type="button" class="button secondary" onClick={() => onChange({ ...value, breaks: [...value.breaks, { start: '', end: '' }] })}>+ Перерыв</button>
    </>}
  </div>;
}

export function SettingsSection({ snapshot, reload }: { snapshot: AdminSnapshot; reload: () => Promise<void> }) {
  const [base, setBase] = useState<AdminSettings>(() => snapshot.settings);
  const [draft, setDraft] = useState<ScheduleDraft>(() => fromSettings(snapshot.settings));
  const [newDate, setNewDate] = useState('');
  const [ack, setAck] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);
  const dirty = isDirty(fromSettings(base), draft);
  useUnsavedChanges(dirty);
  useEffect(() => setAck(false), [draft]);
  useEffect(() => {
    if (!dirty && snapshot.settings.revision > base.revision) {
      setBase(snapshot.settings);
      setDraft(fromSettings(snapshot.settings));
    }
  }, [snapshot.settings, base.revision, dirty]);

  const parsed = useMemo(() => { try { return toSettings(draft, base); } catch { return null; } }, [draft, base]);
  const validation = parsed ? validateSettings(parsed) : 'Проверьте время работы и перерывы';
  const proposed = parsed && !validation ? { ...snapshot, settings: { ...snapshot.settings, ...parsed } } : null;
  const impacted = proposed ? impactedBookings(snapshot, proposed) : [];
  const updateWeekday = (day: number, value: DayDraft) => setDraft(previous => ({ ...previous, weekdays: { ...previous.weekdays, [day]: value } }));
  const updateException = (date: string, value: DayDraft) => setDraft(previous => ({ ...previous, exceptions: { ...previous.exceptions, [date]: value } }));

  const save = async (event: Event) => {
    event.preventDefault(); setError(''); setSuccess('');
    if (!parsed || validation) { setError(validation || 'Проверьте расписание'); return; }
    if (impacted.length && !ack) { setError('Проверьте затронутые записи и подтвердите сохранение.'); return; }
    setBusy(true);
    try {
      if (ack && JSON.stringify(await adminProvider.getSnapshot()) !== JSON.stringify(snapshot)) {
        setAck(false); await reload(); setError('Данные изменились. Проверьте затронутые записи и подтвердите повторно.'); return;
      }
      const saved = await adminProvider.saveSettings(parsed, ack);
      setBase(saved); setDraft(fromSettings(saved));
      await reload(); setSuccess('Расписание сохранено.');
    } catch (cause) {
      if (cause instanceof ScheduleConflictError) { setAck(false); await reload(); }
      setError(messageOf(cause));
    } finally { setBusy(false); }
  };

  return <div class="admin-stack">
    {error && <Notice kind="error">{error}</Notice>}{success && <Notice kind="success">{success}</Notice>}
    <form onSubmit={save} class="admin-stack">
      <Panel><h2>График по дням недели</h2><p>Рабочее время и перерывы действуют для всех категорий.</p></Panel>
      {weekdayNames.map((name, day) => <Panel key={day}><h3>{name}</h3><DayFields value={draft.weekdays[day]} onChange={value => updateWeekday(day, value)} /></Panel>)}
      <Panel><h2>Отдельные даты</h2><p>Расписание даты полностью заменяет обычный график дня.</p>
        <div class="admin-form-grid"><Field label="Дата"><input type="date" value={newDate} onInput={event => setNewDate(event.currentTarget.value)} /></Field><button type="button" class="button secondary" disabled={!validDate(newDate) || Boolean(draft.exceptions[newDate])} onClick={() => { if (validDate(newDate)) { updateException(newDate, freshDay()); setNewDate(''); } }}>+ Добавить дату</button></div>
        {Object.entries(draft.exceptions).sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => <div class="admin-stack" key={date}><div class="admin-section-top"><h3>{date}</h3><button type="button" class="admin-danger" onClick={() => setDraft(previous => ({ ...previous, exceptions: Object.fromEntries(Object.entries(previous.exceptions).filter(([key]) => key !== date)) }))}>Удалить исключение</button></div><DayFields value={value} onChange={next => updateException(date, next)} /></div>)}
      </Panel>
      {dirty && validation && <Notice kind="error">{validation}</Notice>}
      {impacted.length > 0 && <ImpactWarning impacted={impacted} ack={ack} setAck={setAck} />}
      <ActionBar><button class="button secondary" type="button" onClick={() => { setDraft(fromSettings(snapshot.settings)); setBase(snapshot.settings); setError(''); }}>Отменить изменения</button><button class="button primary" type="submit" disabled={!dirty || busy}>{busy ? 'Сохраняем…' : 'Сохранить график'}</button></ActionBar>
    </form>
  </div>;
}
