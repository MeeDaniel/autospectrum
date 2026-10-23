import { formatMinute, parseMinute, type AdminSettings, type DaySchedule, type SettingsInput } from '../../domain/admin';

export type DayDraft = { closed: boolean; start: string; end: string; breaks: Array<{ start: string; end: string }> };
export type ScheduleDraft = { weekdays: Record<number, DayDraft>; exceptions: Record<string, DayDraft> };

function toDayDraft(day: DaySchedule): DayDraft {
  return {
    closed: day.closed,
    start: formatMinute(day.workStart),
    end: formatMinute(day.workEnd),
    breaks: day.breaks.map(pause => ({ start: formatMinute(pause.start), end: formatMinute(pause.end) })),
  };
}

function fromDayDraft(day: DayDraft): DaySchedule {
  return day.closed
    ? { closed: true, workStart: 0, workEnd: 0, breaks: [] }
    : { closed: false, workStart: parseMinute(day.start), workEnd: parseMinute(day.end), breaks: day.breaks.map(pause => ({ start: parseMinute(pause.start), end: parseMinute(pause.end) })) };
}

export function fromSettings(settings: AdminSettings): ScheduleDraft {
  const fallback: DaySchedule = { closed: false, workStart: settings.workStart, workEnd: settings.workEnd, breaks: settings.breaks };
  return {
    weekdays: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, toDayDraft(settings.weekdays?.[day] ?? fallback)])),
    exceptions: Object.fromEntries(Object.entries(settings.exceptions ?? {}).map(([date, day]) => [date, toDayDraft(day)])),
  };
}

export function toSettings(draft: ScheduleDraft, original: AdminSettings): SettingsInput {
  return {
    workStart: original.workStart,
    workEnd: original.workEnd,
    breaks: original.breaks,
    revision: original.revision,
    weekdays: Object.fromEntries(Object.entries(draft.weekdays).map(([day, value]) => [day, fromDayDraft(value)])),
    exceptions: Object.fromEntries(Object.entries(draft.exceptions).map(([date, value]) => [date, fromDayDraft(value)])),
  };
}
