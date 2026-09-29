export type BookingStatus = 'new' | 'confirmed' | 'in_progress' | 'completed' | 'cancelled';
export type Interval = { start: number; end: number };
export type AdminCategory = { id: string; name: string; lineCount: number; archived: boolean; revision: number };
export type AdminService = { id: string; categoryId: string; name: string; priceFrom: number; durationMinutes: number; archived: boolean; revision: number };
export type AdminBooking = {
  id: string; serviceId: string; date: string; startMinute: number; durationMinutes: number;
  name: string; phone: string; car: string; comment: string; status: BookingStatus; revision: number;
};
export type AdminSettings = { workStart: number; workEnd: number; breaks: Interval[]; revision: number };
export type AdminSnapshot = { categories: AdminCategory[]; services: AdminService[]; bookings: AdminBooking[]; settings: AdminSettings };
export type CategoryInput = Omit<AdminCategory, 'id' | 'revision' | 'archived'> & { id?: string; revision?: number };
export type ServiceInput = Omit<AdminService, 'id' | 'revision' | 'archived'> & { id?: string; revision?: number };
export type BookingInput = Omit<AdminBooking, 'id' | 'revision'> & { id?: string; revision?: number };
export type SettingsInput = Omit<AdminSettings, 'revision'> & { revision: number };
export type Conflict = { kind: 'capacity' | 'break' | 'hours'; bookingIds: string[]; start: number; end: number };

export function validMinute(value: number): boolean { return Number.isInteger(value) && value >= 0 && value <= 1439; }
export function parseMinute(value: string): number {
  if (!/^\d{2}:\d{2}$/.test(value)) throw new Error('Некорректное время');
  const [hour, minute] = value.split(':').map(Number);
  const result = hour * 60 + minute;
  if (hour > 23 || minute > 59 || !validMinute(result)) throw new Error('Некорректное время');
  return result;
}
export function formatMinute(value: number): string {
  if (!validMinute(value)) throw new Error('Некорректное время');
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}
export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}
export function validateSettings(settings: Pick<AdminSettings, 'workStart' | 'workEnd' | 'breaks'>): string | null {
  if (!validMinute(settings.workStart) || !validMinute(settings.workEnd) || settings.workStart >= settings.workEnd) return 'Проверьте рабочие часы';
  const breaks = [...settings.breaks].sort((a, b) => a.start - b.start);
  for (let index = 0; index < breaks.length; index++) {
    const item = breaks[index];
    if (!validMinute(item.start) || !validMinute(item.end) || item.start < settings.workStart || item.end > settings.workEnd || item.start >= item.end || (index > 0 && breaks[index - 1].end > item.start)) return 'Проверьте перерывы';
  }
  return null;
}
export function occupiesCapacity(status: BookingStatus): boolean { return status !== 'cancelled' && status !== 'completed'; }

export function assessBooking(booking: BookingInput, snapshot: AdminSnapshot): Conflict[] {
  if (!occupiesCapacity(booking.status)) return [];
  const service = snapshot.services.find(item => item.id === booking.serviceId);
  const category = snapshot.categories.find(item => item.id === service?.categoryId);
  if (!service || !category) return [];
  const start = booking.startMinute;
  const end = start + booking.durationMinutes;
  const conflicts: Conflict[] = [];
  if (start < snapshot.settings.workStart || end > snapshot.settings.workEnd || end > 1439) {
    conflicts.push({ kind: 'hours', bookingIds: [], start, end });
  }
  for (const pause of snapshot.settings.breaks) {
    if (start < pause.end && pause.start < end) conflicts.push({ kind: 'break', bookingIds: [], start: Math.max(start, pause.start), end: Math.min(end, pause.end) });
  }
  const related = snapshot.bookings.filter(other => other.id !== booking.id && other.date === booking.date && occupiesCapacity(other.status) && snapshot.services.find(item => item.id === other.serviceId)?.categoryId === category.id && other.startMinute < end && start < other.startMinute + other.durationMinutes);
  const boundaries = [...new Set([start, end, ...related.flatMap(item => [Math.max(start, item.startMinute), Math.min(end, item.startMinute + item.durationMinutes)])])].sort((a, b) => a - b);
  for (let index = 0; index < boundaries.length - 1; index++) {
    const from = boundaries[index]; const to = boundaries[index + 1];
    if (from === to) continue;
    const active = related.filter(item => item.startMinute < to && item.startMinute + item.durationMinutes > from);
    if (active.length >= category.lineCount) conflicts.push({ kind: 'capacity', bookingIds: active.map(item => item.id), start: from, end: to });
  }
  return conflicts;
}

export function conflictsForDay(snapshot: AdminSnapshot, date: string): Map<string, Conflict[]> {
  const result = new Map<string, Conflict[]>();
  for (const booking of snapshot.bookings.filter(item => item.date === date)) result.set(booking.id, assessBooking(booking, snapshot));
  return result;
}
