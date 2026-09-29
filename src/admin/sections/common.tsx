import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { adminProvider } from '../../data/demo';
import { formatMinute, type AdminSnapshot, type Conflict } from '../../domain/admin';

export function useAdminSnapshot() {
  const [snapshot, setSnapshot] = useState<AdminSnapshot | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const reload = async () => {
    try { setSnapshot(await adminProvider.getSnapshot()); setError(''); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    void reload();
    const unsubscribe = adminProvider.subscribe(() => { void reload(); });
    const onVisible = () => { if (document.visibilityState === 'visible') void reload(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { unsubscribe(); document.removeEventListener('visibilitychange', onVisible); };
  }, []);
  return { snapshot, error, loading, reload };
}

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Не удалось сохранить данные. Попробуйте ещё раз.';
}

export function moscowToday(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (type: string) => parts.find(item => item.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function safeTime(minute: number): string {
  return minute >= 0 && minute <= 1439 ? formatMinute(minute) : `${Math.floor(minute / 60)}:${String(minute % 60).padStart(2, '0')}`;
}

export function Panel({ children, className = '' }: { children: ComponentChildren; className?: string }) {
  return <section class={`admin-panel ${className}`.trim()}>{children}</section>;
}

export function Field({ label, children, hint }: { label: string; children: ComponentChildren; hint?: string }) {
  return <label class="admin-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function ActionBar({ children }: { children: ComponentChildren }) { return <div class="admin-actions">{children}</div>; }

export function Notice({ children, kind = 'info' }: { children: ComponentChildren; kind?: 'info' | 'error' | 'warning' | 'success' }) {
  return <div class={`admin-notice ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>;
}

const conflictLabels = { capacity: 'Превышено число линий', break: 'Перерыв', hours: 'Вне рабочих часов' };
export function ConflictList({ conflicts, snapshot, onOpen }: { conflicts: Conflict[]; snapshot: AdminSnapshot; onOpen?: (id: string) => void }) {
  if (conflicts.length === 0) return null;
  return <div class="admin-conflicts" role="alert"><strong>Обнаружены конфликты</strong><ul>{conflicts.map((conflict, index) => <li key={`${conflict.kind}-${index}`}>
    {conflictLabels[conflict.kind]}: {safeTime(conflict.start)}–{safeTime(conflict.end)}
    {conflict.bookingIds.map(id => {
      const booking = snapshot.bookings.find(item => item.id === id);
      return booking && <span key={id}> · {onOpen ? <button type="button" class="admin-inline-link" onClick={() => onOpen(id)}>{booking.name}, {booking.date} {safeTime(booking.startMinute)}</button> : `${booking.name}, ${booking.date} ${safeTime(booking.startMinute)}`}</span>;
    })}
  </li>)}</ul></div>;
}

export function isDirty<T>(initial: T, draft: T): boolean { return JSON.stringify(initial) !== JSON.stringify(draft); }

export function useUnsavedChanges(dirty: boolean) {
  const previousHash = useRef(typeof window === 'undefined' ? '' : window.location.hash);
  useEffect(() => {
    if (!dirty) { previousHash.current = window.location.hash; return; }
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    const guardRoute = () => {
      if (window.location.hash === previousHash.current) return;
      if (window.confirm('Есть несохранённые изменения. Покинуть раздел?')) previousHash.current = window.location.hash;
      else window.location.hash = previousHash.current;
    };
    window.addEventListener('beforeunload', guard);
    window.addEventListener('hashchange', guardRoute);
    return () => { window.removeEventListener('beforeunload', guard); window.removeEventListener('hashchange', guardRoute); };
  }, [dirty]);
}

export function confirmDiscard(dirty: boolean): boolean { return !dirty || window.confirm('Есть несохранённые изменения. Закрыть форму?'); }

export function useModalFocus(onRequestClose: () => void) {
  const dialog = useRef<HTMLElement>(null);
  const closeRef = useRef(onRequestClose);
  closeRef.current = onRequestClose;
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.querySelector<HTMLElement>('form input, form select, form textarea')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (!element) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = Array.from(element.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]'))
        .filter(item => !item.hasAttribute('disabled') && item.tabIndex >= 0 && item.getClientRects().length > 0);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    element?.addEventListener('keydown', onKeyDown);
    return () => { element?.removeEventListener('keydown', onKeyDown); previous?.focus(); };
  }, []);
  return dialog;
}
