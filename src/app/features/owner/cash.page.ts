import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { limit, orderBy, query } from 'firebase/firestore';
import { expectedCash } from '@shared/domain';
import { CashSession, Shift } from '@shared/models';
import { BusinessService } from '../../core/business.service';
import { liveQuery } from '../../core/live';
import { TsPipe, ZarPipe } from '../../shared/pipes';

/** Daily cash reconciliation report for the owner. */
@Component({
  selector: 'app-cash',
  imports: [DatePipe, DecimalPipe, ZarPipe, TsPipe],
  template: `
    <div class="page-head"><h1>Cash-ups</h1></div>
    <p class="muted small">Expected cash = opening float + cash sales − cash refunds − approved cash expenses − cash paid out. Staff count blind: they never see the expected amount.</p>

    @for (c of sessions.data(); track c.id) {
      @let shift = shifts().get(c.shiftId);
      <div class="card">
        <div class="card-head">
          <div>
            <h2>{{ c.openedAt | ts | date: 'EEE d MMM' }} · {{ c.employeeName }}</h2>
            <span class="tiny">{{ c.openedAt | ts | date: 'HH:mm' }} – {{ c.closedAt ? (c.closedAt | ts | date: 'HH:mm') : 'still open' }}</span>
          </div>
          @if (c.status === 'open') {
            <span class="badge ok">Open</span>
          } @else if (c.differenceCents === 0) {
            <span class="badge ok">Balanced</span>
          } @else {
            <span class="badge" [class.bad]="(c.differenceCents ?? 0) < 0" [class.warn]="(c.differenceCents ?? 0) > 0">
              {{ (c.differenceCents ?? 0) < 0 ? 'Short' : 'Over' }} {{ abs(c.differenceCents ?? 0) | zar }}
            </span>
          }
        </div>

        <div class="grid-2">
          <div class="kv">
            <span>Opening float</span><span>{{ c.openingFloatCents | zar }}</span>
            <span>+ Cash sales</span><span>{{ c.cashSalesCents | zar }}</span>
            <span>− Cash refunds</span><span>{{ c.cashRefundsCents | zar }}</span>
            <span>− Approved cash expenses</span><span>{{ c.approvedCashExpensesCents | zar }}</span>
            <span>− Cash paid out</span><span>{{ c.cashPayoutsCents | zar }}</span>
            <span class="total">Expected</span><span class="total">{{ (c.status === 'open' ? live(c) : c.expectedCashCents) ?? null | zar }}</span>
            @if (c.status === 'closed') {
              <span class="total">Counted</span><span class="total">{{ c.countedCashCents ?? null | zar }}</span>
            }
          </div>
          <div class="kv">
            <span>Card sales recorded</span><span>{{ c.cardSalesCents | zar }}</span>
            @if (c.cardTerminalTotalCents !== null && c.cardTerminalTotalCents !== undefined) {
              <span>Card machine total</span><span>{{ c.cardTerminalTotalCents | zar }}</span>
              <span>Card difference</span><span [style.color]="c.cardDifferenceCents ? 'var(--bad)' : null">{{ c.cardDifferenceCents ?? 0 | zar }}</span>
            }
            <span>EFT sales recorded</span><span>{{ c.eftSalesCents | zar }}</span>
            @if (c.pendingCashExpensesCents) {
              <span>Till expenses awaiting approval</span><span style="color: var(--warn)">{{ c.pendingCashExpensesCents | zar }}</span>
            }
          </div>
        </div>

        @if (c.explanation) {
          <div class="alert warn small" style="margin-top: .75rem"><strong>Explanation:</strong> {{ c.explanation }}</div>
        }
        @if (c.payouts.length) {
          <details style="margin-top: .5rem">
            <summary class="small">Cash paid out ({{ c.payouts.length }})</summary>
            @for (p of c.payouts; track p.at) {
              <div class="small">{{ p.at | date: 'HH:mm' }} · {{ p.amountCents | zar }} · {{ p.reason }} ({{ p.byName }})</div>
            }
          </details>
        }
        @if (shift) {
          <details style="margin-top: .5rem">
            <summary class="small">Checklists, stock count and notes</summary>
            <div class="grid-2" style="margin-top: .5rem">
              <div>
                <h3>Opening</h3>
                @for (i of shift.openingChecklist; track i.item) {
                  <div class="small">{{ i.done ? '✅' : '❌' }} {{ i.item }}</div>
                }
                <h3 style="margin-top: .5rem">Closing</h3>
                @for (i of shift.closingChecklist ?? []; track i.item) {
                  <div class="small">{{ i.done ? '✅' : '❌' }} {{ i.item }}</div>
                }
              </div>
              <div>
                <h3>Stock count variances</h3>
                @for (l of shift.stockCounts ?? []; track l.ingredientId) {
                  @if (l.varianceQty !== 0) {
                    <div class="small">{{ l.ingredientName }}: {{ l.varianceQty > 0 ? '+' : '' }}{{ l.varianceQty | number: '1.0-3' }} {{ l.unit }} ({{ l.varianceCents | zar }})</div>
                  }
                } @empty {
                  <div class="small muted">No stock counted</div>
                }
                @if (shift.notes) {
                  <h3 style="margin-top: .5rem">Notes</h3>
                  <div class="small">{{ shift.notes }}</div>
                }
              </div>
            </div>
          </details>
        }
      </div>
    } @empty {
      <div class="card empty">{{ sessions.loading() ? 'Loading…' : 'No shifts yet' }}</div>
    }
    @if (sessions.data().length >= count()) {
      <button class="btn block" (click)="count.set(count() + 30)">Load older</button>
    }
  `,
})
export class CashPage {
  private readonly biz = inject(BusinessService);
  protected readonly abs = Math.abs;
  protected readonly count = signal(30);
  protected readonly sessions = liveQuery<CashSession>(() => query(this.biz.col('cashSessions'), orderBy('openedAt', 'desc'), limit(this.count())));
  private readonly shiftList = liveQuery<Shift>(() => query(this.biz.col('shifts'), orderBy('openedAt', 'desc'), limit(this.count())));
  protected readonly shifts = computed(() => new Map(this.shiftList.data().map((s) => [s.id, s])));

  protected live(c: CashSession) {
    return expectedCash(c);
  }
}
