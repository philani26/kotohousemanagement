import { describe, expect, it } from 'vitest';
import { TimeEntry, entryMinutes, formatHours, hoursByWorker, isForgotten } from './hours';

const H = 3_600_000;
const entry = (uid: string, dayKey: string, from: number, to: number | null): TimeEntry => ({
  id: `${uid}${from}`,
  uid,
  name: uid,
  role: 'employee',
  dayKey,
  clockInMillis: from,
  clockOutMillis: to,
});

describe('time clock', () => {
  it('counts worked minutes, open entries up to now', () => {
    expect(entryMinutes(entry('a', 'd1', 0, 8 * H), 99 * H)).toBe(480);
    expect(entryMinutes(entry('a', 'd1', 0, null), 2 * H)).toBe(120);
  });

  it('flags a clock-in left open too long', () => {
    expect(isForgotten(entry('a', 'd1', 0, null), 10 * H)).toBe(false);
    expect(isForgotten(entry('a', 'd1', 0, null), 15 * H)).toBe(true);
    expect(isForgotten(entry('a', 'd1', 0, 15 * H), 30 * H)).toBe(false);
  });

  it('totals hours per worker and counts days worked', () => {
    const rows = hoursByWorker(
      [entry('a', 'd1', 0, 4 * H), entry('a', 'd1', 5 * H, 8 * H), entry('a', 'd2', 24 * H, 30 * H), entry('b', 'd1', 0, null)],
      2 * H,
    );
    expect(rows).toEqual([
      { uid: 'a', name: 'a', minutes: 13 * 60, days: 2, entries: 3, open: false },
      { uid: 'b', name: 'b', minutes: 120, days: 1, entries: 1, open: true },
    ]);
  });

  it('formats hours', () => {
    expect(formatHours(425)).toBe('7 h 05 min');
  });
});
