import type { AdminBooking, AdminCategory, AdminService, AdminSettings, AdminSnapshot, BookingInput, CategoryInput, Conflict, ServiceInput, SettingsInput } from '../domain/admin';
import type { BookingDraft, SubmissionResult } from '../domain/booking';
import { RevisionConflictError, ScheduleConflictError, SubmissionRejectedError, type AdminProvider, type BookingProvider } from './demo';

type Staff = { id: string; login: string };
type Session = { staff: Staff; csrfToken: string };
type ApiErrorBody = { code?: string; message?: string; conflicts?: Conflict[] };

function randomKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}

export function createApiProviders() {
  let csrfToken: string | null = null;
  let lastSubmission: { signature: string; key: string } | null = null;
  try { lastSubmission = JSON.parse(sessionStorage.getItem('autospectrum-idempotency') || 'null'); } catch { /* Memory-only key is enough when storage is unavailable. */ }

  async function request<T>(path: string, init: RequestInit = {}, protectedWrite = false): Promise<T> {
    if (protectedWrite && !csrfToken) await currentSession();
    const headers = new Headers(init.headers);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    if (protectedWrite && csrfToken) headers.set('X-CSRF-Token', csrfToken);
    const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
    if (!response.ok) {
      let body: ApiErrorBody = {};
      try { body = await response.json() as ApiErrorBody; } catch { /* Error body may be empty. */ }
      if (body.code === 'unavailable' || body.code === 'invalid') throw new SubmissionRejectedError(body.code);
      if (response.status === 409 && body.code === 'schedule_conflict') throw new ScheduleConflictError(body.conflicts ?? []);
      if (response.status === 409 && body.code === 'revision_conflict') throw new RevisionConflictError();
      throw new Error(body.message || `Сервер вернул ошибку ${response.status}`);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
  async function currentSession(): Promise<Session> {
    const session = await request<Session>('/api/admin/me');
    csrfToken = session.csrfToken;
    return session;
  }
  const auth = {
    currentSession,
    async login(login: string, password: string): Promise<Session> {
      const session = await request<Session>('/api/admin/login', { method: 'POST', body: JSON.stringify({ login, password }) });
      csrfToken = session.csrfToken;
      return session;
    },
    async logout(): Promise<void> {
      await request<void>('/api/admin/logout', { method: 'POST' }, true);
      csrfToken = null;
    },
  };

  const provider: BookingProvider = {
    listServices: () => request('/api/services'),
    getSchedule: () => request('/api/schedule'),
    getAvailability: (serviceId, month) => request(`/api/availability?${new URLSearchParams({ serviceId, month })}`),
    submit: async (draft: BookingDraft): Promise<SubmissionResult> => {
      const signature = JSON.stringify(draft);
      if (lastSubmission?.signature !== signature) {
        lastSubmission = { signature, key: randomKey() };
        try { sessionStorage.setItem('autospectrum-idempotency', JSON.stringify(lastSubmission)); } catch { /* Continue with memory. */ }
      }
      return request('/api/bookings', { method: 'POST', headers: { 'Idempotency-Key': lastSubmission.key }, body: signature });
    },
  };

  const post = <T>(path: string, body: unknown): Promise<T> => request<T>(path, { method: 'POST', body: JSON.stringify(body) }, true);
  const del = (path: string, revision: number): Promise<void> => request<void>(`${path}?revision=${revision}`, { method: 'DELETE' }, true);
  const adminProvider: AdminProvider = {
    getSnapshot: () => request<AdminSnapshot>('/api/admin/snapshot'),
    listBookings: (filters = {}, limit = 50, cursor) => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (filters.from) params.set('from', filters.from);
      if (filters.to) params.set('to', filters.to);
      if (filters.status) params.set('status', filters.status);
      if (cursor) params.set('cursor', cursor);
      return request(`/api/admin/bookings?${params}`);
    },
    previewBooking: (input: BookingInput) => post<Conflict[]>('/api/admin/bookings/preview', { input }),
    saveBooking: (input: BookingInput, allowConflicts = false) => post<AdminBooking>('/api/admin/bookings/save', { input, allowConflicts }),
    deleteBooking: (id, revision) => del(`/api/admin/bookings/${encodeURIComponent(id)}`, revision),
    saveService: (input: ServiceInput, allowConflicts = false) => post<AdminService>('/api/admin/services/save', { input, allowConflicts }),
    deleteService: (id, revision) => del(`/api/admin/services/${encodeURIComponent(id)}`, revision),
    setServiceArchived: (id, revision, archived) => post<AdminService>(`/api/admin/services/${encodeURIComponent(id)}/archive`, { revision, archived }),
    saveCategory: (input: CategoryInput, allowConflicts = false) => post<AdminCategory>('/api/admin/categories/save', { input, allowConflicts }),
    deleteCategory: (id, revision) => del(`/api/admin/categories/${encodeURIComponent(id)}`, revision),
    setCategoryArchived: (id, revision, archived) => post<AdminCategory>(`/api/admin/categories/${encodeURIComponent(id)}/archive`, { revision, archived }),
    saveSettings: (input: SettingsInput, allowConflicts = false) => post<AdminSettings>('/api/admin/settings', { input, allowConflicts }),
    subscribe(listener: () => void) {
      const interval = setInterval(listener, 30000);
      return () => clearInterval(interval);
    },
  };
  return { provider, adminProvider, auth, listAudit: (filters?: { actorId?: string; entity?: string; limit?: number }) => request<unknown[]>(`/api/admin/audit?${new URLSearchParams(Object.entries(filters ?? {}).map(([key, value]) => [key, String(value)]))}`) };
}
