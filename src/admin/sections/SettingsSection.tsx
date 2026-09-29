import { useEffect, useMemo, useState } from 'preact/hooks';
import { adminProvider, ScheduleConflictError } from '../../data/demo';
import { formatMinute, parseMinute, validateSettings, type AdminSettings, type AdminSnapshot, type Interval } from '../../domain/admin';
import { impactedBookings } from './section-model';
import { ActionBar, Field, Notice, Panel, isDirty, messageOf, useUnsavedChanges } from './common';
import { ImpactWarning } from './CatalogSections';

type TimeDraft = { workStart: string; workEnd: string; breaks: { start: string; end: string }[] };
function toDraft(settings: AdminSettings): TimeDraft {
  return { workStart: formatMinute(settings.workStart), workEnd: formatMinute(settings.workEnd), breaks: settings.breaks.map(item => ({ start: formatMinute(item.start), end: formatMinute(item.end) })) };
}
function fromDraft(draft: TimeDraft): Pick<AdminSettings, 'workStart' | 'workEnd' | 'breaks'> | null {
  try { return { workStart: parseMinute(draft.workStart), workEnd: parseMinute(draft.workEnd), breaks: draft.breaks.map(item => ({ start: parseMinute(item.start), end: parseMinute(item.end) })) }; }
  catch { return null; }
}

export function SettingsSection({ snapshot, reload }: { snapshot: AdminSnapshot; reload: () => Promise<void> }) {
  const [baseSettings, setBaseSettings] = useState<AdminSettings>(() => snapshot.settings);
  const [draft, setDraft] = useState<TimeDraft>(() => toDraft(snapshot.settings));
  const [ack, setAck] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);
  const dirty = isDirty(toDraft(baseSettings), draft);
  useUnsavedChanges(dirty);
  useEffect(() => setAck(false), [draft]);
  useEffect(() => setAck(false), [snapshot]);
  useEffect(() => {
    if (!dirty && snapshot.settings.revision > baseSettings.revision) {
      setBaseSettings(snapshot.settings);
      setDraft(toDraft(snapshot.settings));
    }
  }, [snapshot.settings, baseSettings.revision, dirty]);
  const parsed = useMemo(() => fromDraft(draft), [draft]);
  const validation = parsed ? validateSettings(parsed) : 'Проверьте формат времени';
  const proposed = parsed && !validation ? { ...snapshot, settings: { ...snapshot.settings, ...parsed } } : null;
  const impacted = proposed ? impactedBookings(snapshot, proposed) : [];
  const updateBreak = (index: number, patch: Partial<{ start: string; end: string }>) => setDraft(previous => ({ ...previous, breaks: previous.breaks.map((item, idx) => idx === index ? { ...item, ...patch } : item) }));
  const save = async (event: Event) => {
    event.preventDefault(); setError(''); setSuccess('');
    if (!parsed || validation) { setError(validation || 'Проверьте расписание'); return; }
    if (impacted.length && !ack) { setError('Проверьте затронутые записи и подтвердите сохранение.'); return; }
    setBusy(true);
    try {
      if (ack && JSON.stringify(await adminProvider.getSnapshot()) !== JSON.stringify(snapshot)) {
        setAck(false); await reload(); setError('Данные изменились. Проверьте затронутые записи и подтвердите повторно.'); return;
      }
      const saved = await adminProvider.saveSettings({ ...parsed, revision: baseSettings.revision }, ack);
      setBaseSettings(saved);
      setDraft(toDraft(saved));
      await reload();
      setSuccess('Расписание сохранено.');
    }
    catch (cause) { if (cause instanceof ScheduleConflictError) { setAck(false); await reload(); } setError(messageOf(cause)); }
    finally { setBusy(false); }
  };
  return <div class="admin-stack">
    {error && <Notice kind="error">{error} <button class="admin-inline-link" type="button" onClick={() => { void (async () => { const latest = await adminProvider.getSnapshot(); setBaseSettings(latest.settings); setDraft(toDraft(latest.settings)); await reload(); setError(''); })(); }}>Загрузить актуальные данные</button></Notice>}
    {success && <Notice kind="success">{success}</Notice>}
    <Panel><div class="admin-section-top"><div><h2>Ежедневный график</h2><p>Одинаковое расписание действует для всех категорий. Время обрабатывается с точностью до минуты.</p></div></div>
      <form onSubmit={save}><div class="admin-form-grid admin-settings-hours"><Field label="Начало работы"><input type="time" step="60" required value={draft.workStart} onInput={event => setDraft({ ...draft, workStart: event.currentTarget.value })} /></Field><Field label="Конец работы"><input type="time" step="60" required value={draft.workEnd} onInput={event => setDraft({ ...draft, workEnd: event.currentTarget.value })} /></Field></div>
        <div class="admin-settings-break-head"><div><h3>Перерывы</h3><p>Во время перерыва новые записи недоступны.</p></div><button type="button" class="button secondary" onClick={() => setDraft({ ...draft, breaks: [...draft.breaks, { start: '', end: '' }] })}>+ Добавить перерыв</button></div>
        {draft.breaks.length === 0 ? <p class="admin-empty-small">Перерывы не заданы.</p> : <div class="admin-break-list">{draft.breaks.map((item, index) => <div class="admin-break-row" key={index}><span class="admin-break-index">{index + 1}</span><Field label="От"><input type="time" step="60" required value={item.start} onInput={event => updateBreak(index, { start: event.currentTarget.value })} /></Field><Field label="До"><input type="time" step="60" required value={item.end} onInput={event => updateBreak(index, { end: event.currentTarget.value })} /></Field><button type="button" class="admin-danger" onClick={() => setDraft({ ...draft, breaks: draft.breaks.filter((_, idx) => idx !== index) })}>Удалить</button></div>)}</div>}
        {dirty && validation && <Notice kind="error">{validation}</Notice>}
        {impacted.length > 0 && <ImpactWarning impacted={impacted} ack={ack} setAck={setAck} />}
        <ActionBar><button class="button secondary" type="button" onClick={() => { setBaseSettings(snapshot.settings); setDraft(toDraft(snapshot.settings)); setError(''); }}>Отменить изменения</button><button class="button primary" type="submit" disabled={busy || !dirty}>{busy ? 'Сохраняем…' : 'Сохранить график'}</button></ActionBar>
      </form>
    </Panel>
  </div>;
}
