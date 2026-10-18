import { machineScheduleSchema, scheduleOpen, scheduleText } from '@agentbox/shared';
import { describe, expect, it } from 'vitest';

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
// 2026-10-19 is a Monday.
const at = (iso: string) => new Date(iso);

describe('machine schedule', () => {
  it('is always open without a schedule', () => {
    expect(scheduleOpen(null, at('2026-10-19T03:00:00Z'))).toBe(true);
  });

  it('opens from start to stop on the chosen days', () => {
    const s = { start: '09:00', stop: '17:30', days: [1, 2, 3, 4, 5], tz: 'UTC' };
    expect(scheduleOpen(s, at('2026-10-19T08:59:00Z'))).toBe(false);
    expect(scheduleOpen(s, at('2026-10-19T09:00:00Z'))).toBe(true);
    expect(scheduleOpen(s, at('2026-10-19T17:29:00Z'))).toBe(true);
    expect(scheduleOpen(s, at('2026-10-19T17:30:00Z'))).toBe(false);
    // Sunday is not chosen.
    expect(scheduleOpen(s, at('2026-10-18T12:00:00Z'))).toBe(false);
  });

  it('runs past midnight when the stop is earlier than the start', () => {
    // Friday night only.
    const s = { start: '22:00', stop: '02:00', days: [5], tz: 'UTC' };
    expect(scheduleOpen(s, at('2026-10-23T23:00:00Z'))).toBe(true); // Friday 23:00
    expect(scheduleOpen(s, at('2026-10-24T01:59:00Z'))).toBe(true); // Saturday 01:59
    expect(scheduleOpen(s, at('2026-10-24T02:00:00Z'))).toBe(false);
    expect(scheduleOpen(s, at('2026-10-24T23:00:00Z'))).toBe(false); // Saturday night
    expect(scheduleOpen(s, at('2026-10-23T01:00:00Z'))).toBe(false); // early Friday
  });

  it('reads the clock in the schedule’s time zone', () => {
    const s = { start: '09:00', stop: '18:00', days: EVERY_DAY, tz: 'Asia/Kolkata' };
    // 04:00 UTC is 09:30 in India.
    expect(scheduleOpen(s, at('2026-10-19T04:00:00Z'))).toBe(true);
    expect(scheduleOpen(s, at('2026-10-19T13:00:00Z'))).toBe(false);
    // The day is India's too: 20:00 UTC Sunday is 01:30 Monday there.
    const mondays = { start: '00:00', stop: '06:00', days: [1], tz: 'Asia/Kolkata' };
    expect(scheduleOpen(mondays, at('2026-10-18T20:00:00Z'))).toBe(true);
  });

  it('describes itself in plain words', () => {
    const base = { start: '08:00', stop: '23:00', tz: 'UTC' };
    expect(scheduleText({ ...base, days: EVERY_DAY })).toBe('08:00–23:00, every day');
    expect(scheduleText({ ...base, days: [5, 1, 2, 3, 4] })).toBe('08:00–23:00, Mon–Fri');
    expect(scheduleText({ ...base, days: [0, 6] })).toBe('08:00–23:00, weekends');
    expect(scheduleText({ ...base, days: [1, 3, 5] })).toBe('08:00–23:00, Mon, Wed, Fri');
    expect(scheduleText({ ...base, days: [4, 5, 6, 0] })).toBe('08:00–23:00, Thu–Sun');
  });

  it('accepts only real times, days and time zones', () => {
    const ok = { start: '09:00', stop: '22:00', days: EVERY_DAY, tz: 'Asia/Kolkata' };
    expect(machineScheduleSchema.safeParse(ok).success).toBe(true);
    for (const bad of [
      { ...ok, stop: '09:00' },
      { ...ok, start: '9:00' },
      { ...ok, start: '23:60' },
      { ...ok, days: [] },
      { ...ok, days: [1, 1] },
      { ...ok, days: [7] },
      { ...ok, tz: 'Nowhere/Land' },
    ]) {
      expect(machineScheduleSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
