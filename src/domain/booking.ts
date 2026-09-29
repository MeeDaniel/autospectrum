export type Service = {
  id: string;
  name: string;
  priceFrom: number;
  durationMinutes: number;
};

export type Availability = {
  timezone: string;
  startDate: string;
  endDate: string;
  days: Array<{ date: string; times: string[] }>;
};

export type BookingDraft = {
  serviceId: string;
  date: string;
  time: string;
  name: string;
  phone: string;
  car: string;
  comment: string;
};

export type SubmissionResult = {
  status: 'confirmed' | 'overbooked';
  serviceName: string;
  date: string;
  time: string;
};

export const emptyDraft: BookingDraft = {
  serviceId: '', date: '', time: '', name: '', phone: '', car: '', comment: '',
};

export function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) {
    return `+7${digits.slice(1)}`;
  }
  if (digits.length === 10) return `+7${digits}`;
  return value;
}

export function validateDraft(draft: BookingDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!draft.serviceId) errors.serviceId = 'Выберите услугу';
  if (!draft.date || !draft.time) errors.dateTime = 'Выберите дату и время';
  if (!draft.name.trim()) errors.name = 'Введите имя';
  if (!/^\+7\d{10}$/.test(normalizePhone(draft.phone))) errors.phone = 'Введите телефон полностью';
  if (!draft.car.trim()) errors.car = 'Укажите автомобиль';
  return errors;
}
