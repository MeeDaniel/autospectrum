import { describe, expect, it } from 'vitest';
import { fromSettings, toSettings } from './schedule-draft';
import type { AdminSettings } from '../../domain/admin';

describe('weekly schedule editor', () => {
  it('round trips weekday breaks and a closed date', () => {
    const settings: AdminSettings = {
      workStart: 540, workEnd: 1080, breaks: [], revision: 4,
      weekdays: { 2: { closed: false, workStart: 600, workEnd: 960, breaks: [{ start: 720, end: 750 }] } },
      exceptions: { '2026-11-04': { closed: true, workStart: 0, workEnd: 0, breaks: [] } },
    };
    const result = toSettings(fromSettings(settings), settings);
    expect(result.weekdays?.[2]).toEqual(settings.weekdays?.[2]);
    expect(result.exceptions?.['2026-11-04']).toMatchObject({ closed: true });
    expect(result.revision).toBe(4);
  });
});
