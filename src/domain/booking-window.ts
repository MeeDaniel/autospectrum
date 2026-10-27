export type BookingWindow = { startDate: string; endDate: string };

export function bookingWindow(now: Date): BookingWindow {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => Number(parts.find(value => value.type === type)!.value);
  const today = Date.UTC(part('year'), part('month') - 1, part('day'));
  const dateAt = (offset: number) => new Date(today + offset * 86_400_000).toISOString().slice(0, 10);

  return { startDate: dateAt(1), endDate: dateAt(60) };
}

export function isBookableDate(date: string, window: BookingWindow): boolean {
  return date >= window.startDate && date <= window.endDate;
}
