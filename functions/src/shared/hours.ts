/**
 * Staff time clock: pure logic shared by the server and the app.
 * Workers clock in and out on the shop device; the owner sees hours per
 * worker for wages and can close a clock-in someone forgot to end.
 */

/** businesses/{b}/timeEntries/{id} – written by functions only. */
export interface TimeEntry {
  id: string;
  uid: string;
  name: string;
  role: string;
  /** shop day the shift started on (shop time zone) */
  dayKey: string;
  clockInMillis: number;
  /** null while still clocked in */
  clockOutMillis: number | null;
  /** worked minutes, set at clock-out */
  minutes?: number;
  /** set when the owner closed or corrected the entry */
  fixedBy?: string;
  fixReason?: string;
}

/** a clock-in open this long was almost certainly forgotten */
export const FORGOTTEN_HOURS = 14;
/** longest single entry the owner can record */
export const MAX_ENTRY_HOURS = 24;

export function entryMinutes(e: Pick<TimeEntry, 'clockInMillis' | 'clockOutMillis'>, nowMillis: number): number {
  const end = e.clockOutMillis ?? nowMillis;
  return Math.max(0, Math.round((end - e.clockInMillis) / 60_000));
}

export function isForgotten(e: Pick<TimeEntry, 'clockInMillis' | 'clockOutMillis'>, nowMillis: number): boolean {
  return e.clockOutMillis === null && nowMillis - e.clockInMillis > FORGOTTEN_HOURS * 3_600_000;
}

export interface WorkerHours {
  uid: string;
  name: string;
  minutes: number;
  days: number;
  entries: number;
  /** still clocked in now */
  open: boolean;
}

/** Totals per worker, most hours first. Open entries count up to now. */
export function hoursByWorker(entries: TimeEntry[], nowMillis: number): WorkerHours[] {
  const by = new Map<string, WorkerHours & { dayKeys: Set<string> }>();
  for (const e of entries) {
    const w = by.get(e.uid) ?? { uid: e.uid, name: e.name, minutes: 0, days: 0, entries: 0, open: false, dayKeys: new Set<string>() };
    w.minutes += entryMinutes(e, nowMillis);
    w.entries++;
    w.dayKeys.add(e.dayKey);
    if (e.clockOutMillis === null) w.open = true;
    by.set(e.uid, w);
  }
  return [...by.values()]
    .map(({ dayKeys, ...w }) => ({ ...w, days: dayKeys.size }))
    .sort((a, b) => b.minutes - a.minutes);
}

/** "7 h 05 min" */
export function formatHours(minutes: number): string {
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}
