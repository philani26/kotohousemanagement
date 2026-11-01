import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { orderBy, query, where } from 'firebase/firestore';
import { TimeEntry, entryMinutes, formatHours, hoursByWorker, isForgotten } from '@shared/hours';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { BusinessService } from '../../core/business.service';
import { liveQuery } from '../../core/live';
import { ToastService } from '../../core/toast.service';

/** Monday of the week containing a yyyy-mm-dd day. */
function weekStart(dayKey: string): string {
  const d = new Date(`${dayKey}T12:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function addDays(dayKey: string, n: number): string {
  const d = new Date(`${dayKey}T12:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Time clock: staff clock in and out; the owner sees hours per worker for wages. */
@Component({
  selector: 'app-hours',
  imports: [FormsModule, DatePipe],
  template: `
    <div class="page-head"><h1>🕐 Hours</h1></div>

    @if (!auth.isOwner()) {
      <div class="card" style="text-align: center">
        @if (myOpen(); as e) {
          <div class="badge ok">Clocked in</div>
          <div style="font-size: 2rem; font-weight: 800; margin: .5rem 0">{{ hours(minutesOf(e)) }}</div>
          <p class="muted small">since {{ e.clockInMillis | date: 'EEE HH:mm' }}</p>
          <button class="btn charge-btn block" [disabled]="busy()" (click)="clockOut()">Clock out</button>
        } @else {
          <p class="muted">You are not clocked in.</p>
          <button class="btn charge-btn block" [disabled]="busy()" (click)="clockIn()">Clock in</button>
        }
      </div>
    }

    <div class="card">
      <div class="card-head">
        <h2>{{ auth.isOwner() ? 'Staff hours' : 'My hours' }}</h2>
        <div class="row" style="gap: .35rem; flex-wrap: nowrap">
          <button class="btn small" (click)="shiftWeek(-7)" aria-label="Previous week">←</button>
          <span class="small">{{ from() | date: 'd MMM' }} – {{ lastDay() | date: 'd MMM' }}</span>
          <button class="btn small" (click)="shiftWeek(7)" [disabled]="from() >= thisWeek" aria-label="Next week">→</button>
          @if (auth.isOwner()) {
            <button class="btn small" (click)="downloadCsv()">⬇ CSV</button>
          }
        </div>
      </div>

      @if (auth.isOwner()) {
        <div class="table-wrap">
          <table>
            <thead><tr><th>Worker</th><th>Hours</th><th>Days</th><th>Clock-ins</th></tr></thead>
            <tbody>
              @for (w of byWorker(); track w.uid) {
                <tr>
                  <td><strong>{{ w.name }}</strong> @if (w.open) { <span class="badge ok">in now</span> }</td>
                  <td>{{ hours(w.minutes) }}</td>
                  <td>{{ w.days }}</td>
                  <td>{{ w.entries }}</td>
                </tr>
              } @empty {
                <tr><td colspan="4" class="empty">Nobody clocked in this week</td></tr>
              }
            </tbody>
          </table>
        </div>
      } @else {
        <p class="small">This week: <strong>{{ hours(myTotal()) }}</strong></p>
      }

      <h3 style="margin-top: 1rem">Clock-ins</h3>
      @for (e of entries.data(); track e.id) {
        <div class="list-item">
          <div class="main">
            <div class="title">
              @if (auth.isOwner()) { {{ e.name }} · }
              {{ e.clockInMillis | date: 'EEE d MMM HH:mm' }} – {{ e.clockOutMillis ? (e.clockOutMillis | date: 'HH:mm') : 'now' }}
            </div>
            <div class="tiny">
              {{ hours(minutesOf(e)) }}
              @if (e.fixedBy) { · corrected by {{ e.fixedBy }}: {{ e.fixReason }} }
            </div>
          </div>
          @if (forgotten(e)) {
            <span class="badge bad">Forgot to clock out?</span>
          }
          @if (auth.isOwner()) {
            <button class="btn small" (click)="startFix(e)">{{ e.clockOutMillis ? 'Correct' : 'Clock out' }}</button>
          }
        </div>
      } @empty {
        <p class="empty">No clock-ins this week</p>
      }
    </div>

    @if (fixFor(); as e) {
      <div class="dialog-backdrop" (click)="fixFor.set(null)">
        <form class="dialog" (click)="$event.stopPropagation()" (ngSubmit)="saveFix(e)">
          <h2>Clock-out for {{ e.name }}</h2>
          <p class="small">Clocked in {{ e.clockInMillis | date: 'EEE d MMM HH:mm' }}</p>
          <label class="field"><span>Clocked out at</span><input type="datetime-local" name="out" [(ngModel)]="fixOut" required /></label>
          <label class="field"><span>Reason</span><input name="why" [(ngModel)]="fixReason" required placeholder="e.g. forgot to clock out, left at 18:00" /></label>
          <div class="row">
            <button type="button" class="btn" (click)="fixFor.set(null)">Cancel</button>
            <button class="btn primary" [disabled]="busy()">Save</button>
          </div>
        </form>
      </div>
    }
  `,
})
export class HoursPage {
  protected readonly auth = inject(AuthService);
  private readonly biz = inject(BusinessService);
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  protected readonly busy = signal(false);
  protected readonly thisWeek = weekStart(this.biz.today());
  protected readonly from = signal(this.thisWeek);
  protected readonly lastDay = computed(() => addDays(this.from(), 6));
  /** ticks every minute so open clock-ins count up */
  private readonly now = signal(Date.now());

  protected readonly entries = liveQuery<TimeEntry>(() => {
    const fromMs = new Date(`${this.from()}T00:00:00`).getTime();
    const toMs = new Date(`${addDays(this.from(), 7)}T00:00:00`).getTime();
    const range = [where('clockInMillis', '>=', fromMs), where('clockInMillis', '<', toMs), orderBy('clockInMillis', 'desc')];
    return this.auth.isOwner()
      ? query(this.biz.col('timeEntries'), ...range)
      : query(this.biz.col('timeEntries'), where('uid', '==', this.auth.uid()), ...range);
  });
  /** the caller's open clock-in, even if it started last week */
  private readonly openEntries = liveQuery<TimeEntry>(() =>
    this.auth.isOwner() ? null : query(this.biz.col('timeEntries'), where('uid', '==', this.auth.uid()), where('clockOutMillis', '==', null)),
  );
  protected readonly myOpen = computed(() => this.openEntries.data()[0] ?? null);
  protected readonly byWorker = computed(() => hoursByWorker(this.entries.data(), this.now()));
  protected readonly myTotal = computed(() => this.entries.data().reduce((s, e) => s + entryMinutes(e, this.now()), 0));

  protected readonly fixFor = signal<TimeEntry | null>(null);
  protected fixOut = '';
  protected fixReason = '';

  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), 60_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected hours(minutes: number) {
    return formatHours(minutes);
  }

  protected minutesOf(e: TimeEntry) {
    return entryMinutes(e, this.now());
  }

  protected forgotten(e: TimeEntry) {
    return isForgotten(e, this.now());
  }

  protected shiftWeek(days: number) {
    const next = addDays(this.from(), days);
    if (next <= this.thisWeek) this.from.set(next);
  }

  async clockIn() {
    await this.run(async () => {
      const res = await this.api.call('clockIn', {});
      this.toast.ok(res.alreadyIn ? 'You were already clocked in' : 'Clocked in');
    });
  }

  async clockOut() {
    await this.run(async () => {
      const res = await this.api.call('clockOut', {});
      this.toast.ok(`Clocked out – ${formatHours(res.minutes)}`);
    });
  }

  startFix(e: TimeEntry) {
    const suggested = e.clockOutMillis ?? Math.min(Date.now(), e.clockInMillis + 8 * 3_600_000);
    const d = new Date(suggested - new Date(suggested).getTimezoneOffset() * 60_000);
    this.fixOut = d.toISOString().slice(0, 16);
    this.fixReason = '';
    this.fixFor.set(e);
  }

  async saveFix(e: TimeEntry) {
    await this.run(async () => {
      await this.api.call('fixTimeEntry', { entryId: e.id, clockOutMillis: new Date(this.fixOut).getTime(), reason: this.fixReason });
      this.toast.ok('Saved');
      this.fixFor.set(null);
    });
  }

  downloadCsv() {
    const header = ['Worker', 'Day', 'Clock in', 'Clock out', 'Hours', 'Corrected by', 'Reason'];
    const time = (ms: number | null) => (ms ? new Date(ms).toLocaleString('en-ZA') : 'still in');
    const rows = [...this.entries.data()]
      .sort((a, b) => a.name.localeCompare(b.name) || a.clockInMillis - b.clockInMillis)
      .map((e) => [e.name, e.dayKey, time(e.clockInMillis), time(e.clockOutMillis), (entryMinutes(e, this.now()) / 60).toFixed(2), e.fixedBy ?? '', e.fixReason ?? '']);
    const totals = this.byWorker().map((w) => [w.name, 'TOTAL', '', '', (w.minutes / 60).toFixed(2), '', '']);
    const csv = [header, ...rows, [], ...totals].map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `staff-hours-${this.from()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  private async run(fn: () => Promise<unknown>) {
    this.busy.set(true);
    try {
      await fn();
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}
