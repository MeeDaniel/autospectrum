import { useEffect, useRef, useState } from 'preact/hooks';
import { emptyDraft, normalizePhone, validateDraft } from '../domain/booking';
import { formatMinute } from '../domain/admin';
import type { Availability, BookingDraft, Service, SubmissionResult } from '../domain/booking';
import { adminProvider, provider, SubmissionRejectedError } from '../data/demo';
import { goTo, routeFromHash, shiftMonth, type Route } from './navigation';

const draftKey = 'autospectrum.booking.draft';
const resultKey = 'autospectrum.booking.result';
type DisplayResult = SubmissionResult | { status: 'unknown' };
const ruDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const ruMonth = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' });
const weekdays = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validTime(value: string): boolean {
  if (!/^\d{2}:\d{2}$/.test(value)) return false;
  const [hours, minutes] = value.split(':').map(Number);
  return hours < 24 && minutes < 60;
}

function loadDraft(): BookingDraft {
  try {
    const saved = JSON.parse(sessionStorage.getItem(draftKey) || '{}');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return { ...emptyDraft };
    const draft = { ...emptyDraft };
    for (const key of Object.keys(draft) as Array<keyof BookingDraft>) {
      if (typeof saved[key] === 'string') draft[key] = saved[key];
    }
    if (!validDate(draft.date)) { draft.date = ''; draft.time = ''; }
    if (!validTime(draft.time)) draft.time = '';
    return draft;
  } catch {
    return { ...emptyDraft };
  }
}

function loadResult(): DisplayResult | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(resultKey) || 'null');
    if (saved?.status === 'unknown') return { status: 'unknown' };
    if ((saved?.status === 'confirmed' || saved?.status === 'overbooked') &&
      typeof saved.serviceName === 'string' && typeof saved.date === 'string' && typeof saved.time === 'string' &&
      validDate(saved.date) && validTime(saved.time)) {
      return { status: saved.status, serviceName: saved.serviceName, date: saved.date, time: saved.time };
    }
    return null;
  } catch {
    return null;
  }
}

function monthOf(date: string): string {
  if (validDate(date)) return date.slice(0, 7);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  const value = (type: string) => parts.find(part => part.type === type)!.value;
  return `${value('year')}-${value('month')}`;
}

function prettyDate(date: string): string {
  return validDate(date) ? ruDate.format(new Date(`${date}T12:00:00`)) : 'Дата не выбрана';
}

function formatPrice(price: number): string {
  return new Intl.NumberFormat('ru-RU').format(price);
}

function calendarDays(month: string): Array<string | null> {
  const [year, number] = month.split('-').map(Number);
  const first = new Date(year, number - 1, 1);
  const padding = (first.getDay() + 6) % 7;
  const length = new Date(year, number, 0).getDate();
  return [
    ...Array.from({ length: padding }, () => null),
    ...Array.from({ length }, (_, index) => `${year}-${String(number).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}`),
  ];
}

export function App() {
  const [route, setRoute] = useState<Route>(() => routeFromHash(location.hash));
  const [draft, setDraft] = useState<BookingDraft>(loadDraft);
  const [services, setServices] = useState<Service[]>([]);
  const [schedule, setSchedule] = useState<{ workStart: number; workEnd: number } | null>(null);
  const [servicesError, setServicesError] = useState('');
  const [servicesReload, setServicesReload] = useState(0);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [availabilityError, setAvailabilityError] = useState('');
  const [availabilityReload, setAvailabilityReload] = useState(0);
  const [month, setMonth] = useState(() => monthOf(loadDraft().date));
  const [selectionDate, setSelectionDate] = useState(() => loadDraft().date);
  const [selectionTime, setSelectionTime] = useState(() => loadDraft().time);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [retryTime, setRetryTime] = useState(false);
  const [result, setResult] = useState<DisplayResult | null>(loadResult);
  const resultRef = useRef(result);
  const previousRoute = useRef(route);
  const formScroll = useRef(0);

  useEffect(() => {
    const from = previousRoute.current;
    if (from === 'form' && route !== 'form') formScroll.current = window.scrollY;
    requestAnimationFrame(() => {
      window.scrollTo(0, route === 'form' && from !== 'form' ? formScroll.current : 0);
      const heading = document.querySelector<HTMLElement>('main h1');
      if (heading) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
    });
    previousRoute.current = route;
  }, [route]);

  useEffect(() => {
    const onHashChange = () => {
      const requested = routeFromHash(location.hash);
      if (resultRef.current && requested !== 'result') { setRoute('result'); return; }
      if (requested === 'date-time' && !draft.serviceId) { goTo('form'); return; }
      if (requested === 'review' && Object.keys(validateDraft(draft)).length) { goTo('form'); return; }
      if (requested === 'result' && !resultRef.current) { goTo('form'); return; }
      setRoute(requested);
    };
    window.addEventListener('hashchange', onHashChange);
    if (!location.hash) goTo('form');
    else onHashChange();
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [draft, result]);

  useEffect(() => { try { sessionStorage.setItem(draftKey, JSON.stringify(draft)); } catch { /* Private browsing may deny storage. */ } }, [draft]);

  useEffect(() => {
    const reload = () => { setServicesReload(value => value + 1); setAvailabilityReload(value => value + 1); };
    const unsubscribe = adminProvider.subscribe(reload);
    const onVisible = () => { if (document.visibilityState === 'visible') reload(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { unsubscribe(); document.removeEventListener('visibilitychange', onVisible); };
  }, []);

  useEffect(() => {
    let live = true;
    provider.listServices().then(value => { if (live) { setServices(value); setServicesError(''); } }).catch(() => {
      if (live) setServicesError('Не удалось загрузить услуги. Попробуйте ещё раз.');
    });
    return () => { live = false; };
  }, [servicesReload]);

  useEffect(() => {
    let live = true;
    provider.getSchedule().then(value => { if (live) setSchedule(value); }).catch(() => { if (live) setSchedule(null); });
    return () => { live = false; };
  }, [servicesReload]);

  useEffect(() => {
    if (!draft.serviceId || route !== 'date-time') return;
    let live = true;
    setLoading(true);
    setAvailability(null);
    setAvailabilityError('');
    provider.getAvailability(draft.serviceId, month).then(value => {
      if (live) setAvailability(value);
    }).catch(() => {
      if (live) setAvailabilityError('Не удалось загрузить свободное время. Попробуйте ещё раз.');
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [draft.serviceId, month, route, availabilityReload]);

  const selectedService = services.find(service => service.id === draft.serviceId);
  const currentErrors = Object.keys(errors).length ? errors : {};

  function change<K extends keyof BookingDraft>(key: K, value: BookingDraft[K]) {
    setDraft(previous => ({ ...previous, [key]: value }));
    setErrors(previous => ({ ...previous, [key]: '', ...(key === 'date' || key === 'time' ? { dateTime: '' } : {}) }));
  }

  function chooseService(id: string) {
    setDraft(previous => ({ ...previous, serviceId: id, date: '', time: '' }));
    setSelectionDate('');
    setSelectionTime('');
    setErrors(previous => ({ ...previous, serviceId: '' }));
  }

  function continueToReviewFromForm(event: Event) {
    event.preventDefault();
    const found = validateDraft({ ...draft, phone: normalizePhone(draft.phone) });
    setErrors(found);
    if (Object.keys(found).length) {
      requestAnimationFrame(() => {
        const target = found.serviceId ? '.field select' : found.dateTime ? '.date-choice button' : '.field [aria-invalid="true"]';
        document.querySelector<HTMLElement>(target)?.focus();
      });
      return;
    }
    setDraft(previous => ({ ...previous, phone: normalizePhone(previous.phone) }));
    goTo('review');
  }

  function chooseDateTime() {
    const found: Record<string, string> = {};
    if (!selectionDate || !selectionTime) found.dateTime = 'Выберите дату и время';
    const slot = availability?.days.find(day => day.date === selectionDate);
    if (!slot?.times.includes(selectionTime)) found.dateTime = 'Выберите доступное время';
    setErrors(found);
    if (Object.keys(found).length) return;
    setDraft(previous => ({ ...previous, date: selectionDate, time: selectionTime }));
    goTo('form');
  }

  async function confirm() {
    if (submitting) return;
    if (resultRef.current) { goTo('result'); return; }
    const found = validateDraft(draft);
    if (Object.keys(found).length) { setErrors(found); goTo('form'); return; }
    setSubmitting(true);
    setSubmitError('');
    setRetryTime(false);
    try {
      const response = await provider.submit(draft);
      try { sessionStorage.setItem(resultKey, JSON.stringify(response)); } catch { /* Keep the result in memory. */ }
      resultRef.current = response;
      setResult(response);
      goTo('result');
    } catch (error) {
      if (error instanceof SubmissionRejectedError) {
        setSubmitError(error.message);
        setRetryTime(error.reason === 'unavailable');
        return;
      }
      const unknown: DisplayResult = { status: 'unknown' };
      try { sessionStorage.setItem(resultKey, JSON.stringify(unknown)); } catch { /* Keep the result in memory. */ }
      resultRef.current = unknown;
      setResult(unknown);
      goTo('result');
    } finally {
      setSubmitting(false);
    }
  }

  function startAgain() {
    try { sessionStorage.removeItem(resultKey); } catch { /* Continue with in-memory state. */ }
    resultRef.current = null;
    setResult(null);
    setDraft(previous => ({ ...emptyDraft, name: previous.name, phone: previous.phone, car: previous.car }));
    setErrors({});
    goTo('form');
  }

  const bookingStep = route === 'date-time' ? 2 : route === 'review' ? 3 : 1;

  return <div class="site-shell">
    <header class="site-header">
      <a class="brand" href="#/" aria-label="АвтоСпектр — на главную">
        <span class="brand-mark" aria-hidden="true" />
        <span class="brand-copy"><strong>АВТОСПЕКТР</strong><small>Автосервис с заботой о вас</small></span>
      </a>
      <span class="header-link">Демонстрационная версия</span>
    </header>

    <main class="main-content">
      {route === 'form' && <div class="narrow-flow">
        <section class="intro">
          <div><p class="eyebrow">ОНЛАЙН-ЗАПИСЬ В АВТОСЕРВИС</p><h1>Запишитесь<br /><em>в АвтоСпектр</em></h1><p>Выберите услугу и удобное время, затем проверьте данные заявки.</p></div>
          <div class="demo-details"><strong>Информация для примера</strong><span>Адрес: будет указан после настройки</span><span>Телефон: будет указан после настройки</span><span>Часы: {schedule ? `${formatMinute(schedule.workStart)}–${formatMinute(schedule.workEnd)}` : 'уточняются'} (демо)</span></div>
        </section>
        <p class="demo-warning" role="note">Демонстрационный режим: запись и свободное время показаны для примера. Настоящая заявка в автосервис не отправляется.</p>
        <form class="booking-layout" onSubmit={continueToReviewFromForm} noValidate>
          <section class="card main-card">
            <div class="section-heading"><span class="section-number">01</span><div><h2>Услуга</h2><p>Что нужно сделать с автомобилем?</p></div></div>
            {servicesError && <div class="alert" role="alert"><p>{servicesError}</p><button type="button" onClick={() => { setServicesError(''); setServicesReload(value => value + 1); }}>Повторить загрузку услуг</button></div>}
            {!services.length && !servicesError && <p class="muted">Загружаем услуги…</p>}
            <div className="field-grid">
              <label class="field"><span>Услуга <b>*</b></span><select value={draft.serviceId} onChange={event => chooseService(event.currentTarget.value)} aria-invalid={!!currentErrors.serviceId}><option value="">Выберите услугу</option>{services.map(service => <option value={service.id} key={service.id}>{service.name} · от {formatPrice(service.priceFrom)} ₽ · ~{service.durationMinutes} мин</option>)}</select>{currentErrors.serviceId && <p class="field-error" role="alert">{currentErrors.serviceId}</p>}</label>
              <label class="field"><span>Автомобиль <b>*</b></span><input autoComplete="off" value={draft.car} onInput={event => change('car', event.currentTarget.value)} placeholder="Например, Kia Rio 2019" aria-invalid={!!currentErrors.car} />{currentErrors.car && <small class="field-error">{currentErrors.car}</small>}</label>
              <label class="field full"><span>Комментарий <small>(необязательно)</small></span><textarea rows={3} value={draft.comment} onInput={event => change('comment', event.currentTarget.value)} placeholder="Расскажите, что беспокоит или что нам стоит знать" /></label>
            </div>
            {selectedService && <p class="price-note">Учтите, что итоговая цена зависит от автомобиля</p>}
            <div class="section-divider" />
            <div class="section-heading"><span class="section-number">02</span><div><h2>Дата и время</h2><p>Выберите свободное окно для визита</p></div></div>
            <div class="date-choice"><div><strong>{draft.date ? prettyDate(draft.date) : 'Дата не выбрана'}</strong><span>{!draft.serviceId ? 'Сначала выберите услугу' : draft.time || 'Время не выбрано'}</span></div><button class="button secondary" type="button" disabled={!draft.serviceId} onClick={() => { setMonth(monthOf(draft.date)); setSelectionDate(draft.date); setSelectionTime(draft.time); goTo('date-time'); }}>Выбрать дату и время</button></div>
            {currentErrors.dateTime && <p class="field-error" role="alert">{currentErrors.dateTime}</p>}
            <div class="section-divider" />
            <div class="section-heading"><span class="section-number">03</span><div><h2>Ваши данные</h2><p>Чтобы мы могли связаться с вами</p></div></div>
            <div class="field-grid">
              <label class="field"><span>Ваше имя <b>*</b></span><input autoComplete="name" value={draft.name} onInput={event => change('name', event.currentTarget.value)} placeholder="Как к вам обращаться" aria-invalid={!!currentErrors.name} />{currentErrors.name && <small class="field-error">{currentErrors.name}</small>}</label>
              <label class="field"><span>Телефон <b>*</b></span><input type="tel" autoComplete="tel" inputMode="tel" value={draft.phone} onInput={event => change('phone', event.currentTarget.value)} onBlur={() => { if (draft.phone) change('phone', normalizePhone(draft.phone)); }} placeholder="+7 (999) 123-45-67" aria-invalid={!!currentErrors.phone} />{currentErrors.phone && <small class="field-error">{currentErrors.phone}</small>}</label>
            </div>
          </section>
          <div class="form-actions"><button class="button primary" type="submit">Далее</button></div>
        </form>
      </div>}

      {route === 'date-time' && <div class="narrow-flow">
        <button class="back-link" type="button" onClick={() => goTo('form')}>← Назад к форме</button>
        <div class="flow-heading"><p class="eyebrow">ВЫБОР ВРЕМЕНИ</p><h1>Выберите дату <em>и время</em></h1><p>Свободные окна для услуги «{selectedService?.name || 'выбранная услуга'}».</p></div>
        <section class="card calendar-card">
          <div class="calendar-top"><div><h2>{ruMonth.format(new Date(`${month}-01T12:00:00`))}</h2><p>Доступные даты выделены</p></div><div class="month-controls"><button type="button" aria-label="Предыдущий месяц" onClick={() => { setMonth(shiftMonth(month, -1)); setSelectionDate(''); setSelectionTime(''); }}>←</button><button type="button" aria-label="Следующий месяц" onClick={() => { setMonth(shiftMonth(month, 1)); setSelectionDate(''); setSelectionTime(''); }}>→</button></div></div>
          {loading && <p class="muted" role="status">Загружаем свободные даты…</p>}
          {availabilityError && <div class="alert" role="alert"><p>{availabilityError}</p><button type="button" onClick={() => setAvailabilityReload(value => value + 1)}>Повторить загрузку времени</button></div>}
          {!loading && availability && <div class="calendar-grid" aria-label="Календарь доступных дат">
            {weekdays.map(day => <span class="weekday" key={day}>{day}</span>)}
            {calendarDays(month).map((date, index) => {
              const day = availability.days.find(item => item.date === date);
              const available = !!day?.times.length;
              return date ? <button key={date} type="button" disabled={!available} class={selectionDate === date ? 'calendar-day chosen' : 'calendar-day'} aria-label={`${prettyDate(date)}${available ? '' : ', нет свободного времени'}`} aria-pressed={selectionDate === date} onClick={() => { setSelectionDate(date); setSelectionTime(''); setErrors(previous => ({ ...previous, dateTime: '' })); }}>{Number(date.slice(-2))}</button> : <span key={`blank-${index}`} />;
            })}
          </div>}
          {!loading && availability && !availability.days.some(day => day.date.startsWith(month) && day.times.length) && <p class="calendar-empty">В этом месяце свободных окон пока нет. Посмотрите следующий месяц.</p>}
          <div class="time-section"><h3>Время {selectionDate && <span>· {prettyDate(selectionDate)}</span>}</h3>
            {selectionDate ? <div class="time-grid">{availability?.days.find(day => day.date === selectionDate)?.times.map(time => <button key={time} type="button" class={selectionTime === time ? 'time-option chosen' : 'time-option'} aria-pressed={selectionTime === time} onClick={() => { setSelectionTime(time); setErrors(previous => ({ ...previous, dateTime: '' })); }}>{time}</button>) || <p class="muted">На этот день свободного времени нет.</p>}</div> : <p class="muted">Сначала выберите дату в календаре.</p>}
          </div>
          {currentErrors.dateTime && <p class="field-error" role="alert">{currentErrors.dateTime}</p>}
        </section>
        <div class="flow-actions"><button class="button primary" type="button" onClick={chooseDateTime}>Выбрать</button></div>
      </div>}

      {route === 'review' && <div class="narrow-flow">
        <div class="flow-heading"><h1>Проверьте <em>запись</em></h1><p>Если всё верно, отправьте заявку. Мы сохраним выбранное время.</p></div>
        <section class="card review-card"><div class="review-head"><span class="review-icon">✓</span><div><h2>Детали записи</h2><p>Всё готово к подтверждению</p></div></div>
          <dl class="review-list">
            <div><dt>Услуга</dt><dd>{selectedService?.name || '—'}</dd></div>
            <div><dt>Автомобиль</dt><dd>{draft.car || '—'}</dd></div>
            {draft.comment && <div><dt>Комментарий</dt><dd>{draft.comment}</dd></div>}
            <div><dt>Дата</dt><dd>{prettyDate(draft.date)}</dd></div>
            <div><dt>Время</dt><dd>{draft.time || '—'}</dd></div>
            <div><dt>Имя</dt><dd>{draft.name || '—'}</dd></div>
            <div><dt>Телефон</dt><dd>{draft.phone || '—'}</dd></div>
          </dl>
        </section>
        {submitError && <div class="alert" role="alert"><p>{submitError}</p>{retryTime && <button type="button" onClick={() => { setSubmitError(''); setMonth(monthOf(draft.date)); setSelectionDate(draft.date); setSelectionTime(''); goTo('date-time'); }}>Выбрать другое время</button>}</div>}
        <div class="flow-actions"><button class="button secondary" type="button" onClick={() => goTo('form')}>Назад</button><button class="button primary" type="button" disabled={submitting} onClick={confirm}>{submitting ? 'Отправляем…' : 'Отправить'}</button></div>
      </div>}

      {route === 'result' && <div class="result-wrap">
        <div class="card result-card">
          <span class={result?.status === 'confirmed' ? 'result-icon' : 'result-icon warning'}>{result?.status === 'confirmed' ? '✓' : '!'}</span>
          <p class="eyebrow">АВТОСПЕКТР · ДЕМО</p>
          <h1>{result?.status === 'unknown' ? 'Статус заявки неизвестен' : result?.status === 'overbooked' ? 'Заявка принята' : 'Вы записаны'}</h1>
          <p class="result-description">{result?.status === 'unknown' ? 'Не удалось узнать, сохранилась ли заявка. Когда будут настроены контакты сервиса, уточните статус у менеджера перед повторной отправкой.' : result?.status === 'overbooked' ? 'Заявка принята. На это время много записей — возможен перенос. Менеджер может связаться с вами в рабочее время.' : 'Демонстрационная заявка сохранена. Настоящая запись станет доступна после подключения сервиса.'}</p>
          {result && result.status !== 'unknown' && <div class="result-summary"><strong>{result.serviceName}</strong><span>{prettyDate(result.date)} · {result.time}</span></div>}
          <button class="button primary" type="button" onClick={startAgain}>ОК</button>
        </div>
      </div>}
    </main>
    <footer class="site-footer"><span>© {new Date().getFullYear()} АвтоСпектр</span><span>Автосервис, которому доверяют</span></footer>
  </div>;
}
