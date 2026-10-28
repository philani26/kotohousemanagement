import { orderBy, query, where } from 'firebase/firestore';
import { DailyStats } from '@shared/models';
import { normaliseStats } from '@shared/domain';
import { BusinessService } from '../../core/business.service';
import { liveQuery } from '../../core/live';

export type Period = 'today' | 'week' | 'month';

/** YYYY-MM-DD n days before the given day key. */
export function daysBefore(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export function periodRange(period: Period, today: string): { from: string; to: string } {
  if (period === 'today') return { from: today, to: today };
  if (period === 'week') return { from: daysBefore(today, 6), to: today };
  return { from: daysBefore(today, 29), to: today };
}

/** Live daily stats for a day-key range (must run in an injection context). */
export function liveStats(biz: BusinessService, range: () => { from: string; to: string } | null) {
  const live = liveQuery<DailyStats>(() => {
    const r = range();
    return r ? query(biz.col('dailyStats'), where('dayKey', '>=', r.from), where('dayKey', '<=', r.to), orderBy('dayKey')) : null;
  });
  return { ...live, normalised: () => live.data().map(normaliseStats) };
}

export const CHART_COLOURS = {
  sales: '#c2410c',
  profit: '#15803d',
  expenses: '#b45309',
  cash: '#1f1a17',
  card: '#1d4ed8',
  eft: '#f2b33d',
};
