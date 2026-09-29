import { describe, expect, it } from 'vitest';
import { normalizePhone, validateDraft, emptyDraft } from './booking';

describe('phone and booking validation', () => {
  it('normalizes an 8-prefixed Russian phone', () => {
    expect(normalizePhone('8 (999) 123-45-67')).toBe('+79991234567');
  });

  it('rejects an incomplete phone and missing mandatory values', () => {
    expect(validateDraft({ ...emptyDraft, phone: '+7999123' })).toEqual({
      serviceId: 'Выберите услугу',
      dateTime: 'Выберите дату и время',
      name: 'Введите имя',
      phone: 'Введите телефон полностью',
      car: 'Укажите автомобиль',
    });
  });

  it('accepts a complete booking without a comment', () => {
    expect(validateDraft({
      serviceId: 'oil', date: '2026-10-12', time: '11:30',
      name: 'Иван', phone: '+79991234567', car: 'Лада Гранта', comment: '',
    })).toEqual({});
  });
});
