import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ChartConfiguration } from 'chart.js';
import { limit, orderBy, query, where } from 'firebase/firestore';
import { dayRange, emptyDailyStats, expectedCash, isLowStock, profitSummary, sumStats } from '@shared/domain';
import {
  AppNotification,
  AuditLog,
  CashSession,
  DailyStats,
  EXPENSE_INVENTORY_CATEGORY,
  Expense,
  Ingredient,
  Sale,
  StockMovement,
} from '@shared/models';
import { BusinessService } from '../../core/business.service';
import { liveDoc, liveQuery } from '../../core/live';
import { ChartComponent } from '../../shared/chart.component';
import { TsPipe, ZarPipe } from '../../shared/pipes';
import { CHART_COLOURS, Period, daysBefore, liveStats, periodRange } from './stats';

@Component({
  selector: 'app-dashboard',
  imports: [RouterLink, DatePipe, DecimalPipe, ZarPipe, TsPipe, ChartComponent],
  template: `
    <div class="page-head">
      <h1>Dashboard</h1>
      <div class="seg">
        @if (biz.openShift()) {
          <button [class.on]="period() === 'shift'" (click)="setPeriod('shift')">This shift</button>
        }
        <button [class.on]="period() === 'today'" (click)="setPeriod('today')">Today</button>
        <button [class.on]="period() === 'week'" (click)="setPeriod('week')">7 days</button>
        <button [class.on]="period() === 'month'" (click)="setPeriod('month')">30 days</button>
      </div>
    </div>

    @if (period() === 'shift' && biz.openShift(); as s) {
      <p class="muted small" style="margin-top: -.5rem">
        {{ s.employeeName }}'s shift since {{ s.openedAt | ts | date: 'HH:mm' }}. Figures below count this shift only, starting from the opening float.
      </p>
    }

    @for (n of alerts.data(); track n.id) {
      <a class="alert" [class.bad]="n.severity === 'critical'" [class.warn]="n.severity === 'warning'" [class.info]="n.severity === 'info'"
        style="display: block; text-decoration: none" [routerLink]="n.link || '/notifications'">
        <strong>{{ n.title }}</strong> – {{ n.message }}
      </a>
    }

    <div class="stats">
      <div class="stat brand">
        <div class="label">Sales (revenue)</div>
        <div class="value">{{ profit().netRevenueCents | zar }}</div>
        <div class="sub">{{ totals().orders }} orders · avg {{ avgOrder() | zar }}</div>
        @if (change(); as c) {
          <div class="sub" [style.color]="c.pct >= 0 ? '#86efac' : '#fca5a5'">{{ c.pct >= 0 ? '▲' : '▼' }} {{ abs(c.pct) }}% vs {{ c.label }}</div>
        }
      </div>
      <div class="stat" [class.good]="profit().grossProfitCents > 0">
        <div class="label">Gross profit (est.)</div>
        <div class="value">{{ profit().grossProfitCents | zar }}</div>
        <div class="sub">{{ profit().grossMarginPercent }}% margin after ingredients</div>
      </div>
      <div class="stat" [class.good]="profit().operatingProfitCents > 0" [class.bad]="profit().operatingProfitCents < 0">
        <div class="label">Operating profit (est.)</div>
        <div class="value">{{ profit().operatingProfitCents | zar }}</div>
        <div class="sub">after expenses & stock losses</div>
      </div>
      <div class="stat">
        <div class="label">Expenses</div>
        <div class="value">{{ totals().operatingExpensesCents | zar }}</div>
        <div class="sub">approved · stock bought {{ totals().inventoryPurchasesCents | zar }}</div>
      </div>
    </div>

    <div class="stats">
      @if (period() === 'shift' && session.data(); as c) {
        <div class="stat">
          <div class="label">Cash in till</div>
          <div class="value">{{ expected() | zar }}</div>
          <div class="sub">float {{ c.openingFloatCents | zar }} + cash sales {{ c.cashSalesCents | zar }}</div>
        </div>
      } @else {
        <div class="stat"><div class="label">Cash</div><div class="value">{{ totals().byMethod.cash | zar }}</div></div>
      }
      <div class="stat"><div class="label">Card</div><div class="value">{{ totals().byMethod.card | zar }}</div></div>
      <div class="stat"><div class="label">EFT</div><div class="value">{{ totals().byMethod.eft | zar }}</div></div>
      <div class="stat" [class.bad]="profit().stockLossesCents > 0">
        <div class="label">Wastage & losses</div>
        <div class="value">{{ profit().stockLossesCents | zar }}</div>
        <div class="sub">refunds {{ totals().refundsCents | zar }}</div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-head">
          <h2>Till right now</h2>
          @if (biz.openShift(); as s) {
            <span class="badge ok">Open · {{ s.employeeName }} since {{ s.openedAt | ts | date: 'HH:mm' }}</span>
          } @else {
            <span class="badge">No open shift</span>
          }
        </div>
        @if (session.data(); as c) {
          <div class="kv">
            <span>Opening float</span><span>{{ c.openingFloatCents | zar }}</span>
            <span>+ Cash sales</span><span>{{ c.cashSalesCents | zar }}</span>
            <span>− Cash refunds</span><span>{{ c.cashRefundsCents | zar }}</span>
            <span>− Approved cash expenses</span><span>{{ c.approvedCashExpensesCents | zar }}</span>
            <span>− Cash paid out</span><span>{{ c.cashPayoutsCents | zar }}</span>
            <span class="total">Expected cash in till</span><span class="total">{{ expected() | zar }}</span>
          </div>
          @if (c.pendingCashExpensesCents) {
            <p class="alert warn small" style="margin-top: .75rem">
              {{ c.pendingCashExpensesCents | zar }} of till expenses are waiting for your approval.
              <a routerLink="/approvals">Review</a>
            </p>
          }
          <p class="tiny" style="margin-top: .5rem">Card {{ c.cardSalesCents | zar }} · EFT {{ c.eftSalesCents | zar }} this shift</p>
        } @else {
          <p class="muted">The cash balance appears here while a shift is open. <a routerLink="/cash">See past cash-ups</a></p>
        }
      </div>

      <div class="card">
        <div class="card-head"><h2>Sales trend</h2></div>
        <app-chart [config]="trendChart()" [height]="220" />
      </div>
    </div>

    <div class="grid-3">
      <div class="card">
        <div class="card-head">
          <h2>Needs attention</h2>
        </div>
        <div class="list">
          <a class="list-item" routerLink="/approvals" style="text-decoration: none; color: inherit">
            <div class="main"><div class="title">Pending approvals</div><div class="small muted">Refunds, expenses, stock corrections</div></div>
            <span class="badge" [class.warn]="pending.data().length">{{ pending.data().length }}</span>
          </a>
          @for (i of lowStock(); track i.id) {
            <a class="list-item" routerLink="/stock" style="text-decoration: none; color: inherit">
              <div class="main"><div class="title">{{ i.name }}</div><div class="small muted">{{ (i.currentQty > 0 ? i.currentQty : 0) | number: '1.0-2' }} {{ i.unit }} left · reorder at {{ i.reorderLevel }}</div></div>
              <span class="badge bad">Low</span>
            </a>
          }
          @if (!lowStock().length) {
            <div class="list-item"><div class="main muted small">Stock levels are fine</div></div>
          }
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Best sellers</h2></div>
        <div class="list">
          @for (p of bestSellers(); track p.id) {
            <div class="list-item">
              <div class="main"><div class="title">{{ p.name }}</div></div>
              <span class="small">{{ p.qty }} sold</span>
              <strong class="money small">{{ p.revenueCents | zar }}</strong>
            </div>
          } @empty {
            <p class="empty">No sales in this period</p>
          }
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Recent sales</h2><a routerLink="/sales" class="small">All</a></div>
        <div class="list">
          @for (s of recentSales.data(); track s.id) {
            <div class="list-item">
              <div class="main">
                <div class="title">#{{ s.receiptNo }} · {{ s.totalCents | zar }}</div>
                <div class="tiny">{{ s.createdAt | ts | date: 'HH:mm' }} · {{ s.employeeName }} · {{ s.payment.method }}</div>
              </div>
              @if (s.status !== 'completed') {
                <span class="badge warn">{{ s.status }}</span>
              }
            </div>
          } @empty {
            <p class="empty">No sales yet</p>
          }
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Recent activity</h2><a routerLink="/audit" class="small">Activity log</a></div>
      <div class="list">
        @for (a of activity.data(); track a.id) {
          <div class="list-item">
            <div class="main">
              <span class="title">{{ a.actorName }}</span>&nbsp;<span class="muted">{{ describe(a) }}</span>
            </div>
            <span class="tiny">{{ a.at | ts | date: 'd MMM HH:mm' }}</span>
          </div>
        } @empty {
          <p class="empty">No activity yet</p>
        }
      </div>
    </div>
  `,
})
export class DashboardPage {
  protected readonly biz = inject(BusinessService);
  /** 'shift' = only the open shift, starting from its opening float */
  private readonly chosen = signal<Period | 'shift' | null>(null);
  protected readonly period = computed<Period | 'shift'>(() => {
    const c = this.chosen() ?? (this.biz.openShift() ? 'shift' : 'today');
    return c === 'shift' && !this.biz.openShift() ? 'today' : c;
  });
  /** day-based period used for the stats queries (the shift view still needs today's for comparisons) */
  private readonly dayPeriod = computed<Period>(() => (this.period() === 'shift' ? 'today' : (this.period() as Period)));
  private readonly range = computed(() => periodRange(this.dayPeriod(), this.biz.today()));

  setPeriod(p: Period | 'shift') {
    this.chosen.set(p);
  }

  // ---- this shift only ----
  private readonly shiftId = computed(() => (this.period() === 'shift' ? (this.biz.openShift()?.id ?? null) : null));
  private readonly shiftSales = liveQuery<Sale>(() => {
    const id = this.shiftId();
    return id ? query(this.biz.col('sales'), where('shiftId', '==', id)) : null;
  });
  private readonly shiftMovements = liveQuery<StockMovement>(() => {
    const id = this.shiftId();
    return id ? query(this.biz.col('stockMovements'), where('shiftId', '==', id)) : null;
  });
  private readonly shiftExpenses = liveQuery<Expense>(() => {
    const id = this.shiftId();
    return id ? query(this.biz.col('expenses'), where('shiftId', '==', id)) : null;
  });
  /** Builds the same counters as dailyStats, but from this shift's own records. */
  private readonly shiftTotals = computed<DailyStats>(() => {
    const t = emptyDailyStats(this.biz.openShift()?.dayKey ?? this.biz.today());
    for (const s of this.shiftSales.data()) {
      t.grossSalesCents += s.totalCents;
      t.discountsCents += s.discountCents;
      t.orders++;
      t.byMethod[s.payment.method] += s.totalCents;
      t.cogsCents += s.costCents;
      if (s.status === 'refunded') {
        t.refundsCents += s.totalCents;
        t.refundedCogsCents += s.costCents;
        t.refundCount++;
      }
      for (const l of s.lines) {
        const p = (t.products[l.productId] ??= { name: l.name, qty: 0, revenueCents: 0 });
        p.qty += l.quantity;
        p.revenueCents += l.lineTotalCents;
      }
    }
    for (const m of this.shiftMovements.data()) {
      if (m.type === 'wastage') t.wastageCostCents += m.valueCents;
      else if (m.type === 'staffMeal' || m.type === 'complimentary') t.staffMealCostCents += m.valueCents;
      else if (m.type === 'adjustment') t.stockAdjustmentCents += Math.sign(m.qtyChange) * m.valueCents;
      else if (m.type === 'purchase') t.inventoryPurchasesCents += m.valueCents;
    }
    for (const e of this.shiftExpenses.data().filter((x) => x.status === 'approved')) {
      if (e.category === EXPENSE_INVENTORY_CATEGORY) t.inventoryPurchasesCents += e.amountCents;
      else t.operatingExpensesCents += e.amountCents;
    }
    return t;
  });

  private readonly stats = liveStats(this.biz, () => this.range());
  protected readonly abs = Math.abs;

  /** Same period one cycle earlier: today vs the same weekday last week, 7/30 days vs the previous 7/30. */
  private readonly offsetDays = computed(() => (this.dayPeriod() === 'month' ? 30 : 7));
  private readonly previous = liveStats(this.biz, () => {
    const r = this.range();
    return { from: daysBefore(r.from, this.offsetDays()), to: daysBefore(r.to, this.offsetDays()) };
  });
  protected readonly change = computed(() => {
    if (this.period() === 'shift') return null; // a shift has no like-for-like earlier period
    const before = profitSummary(sumStats(this.previous.normalised())).netRevenueCents;
    if (before <= 0) return null;
    const pct = Math.round(((this.profit().netRevenueCents - before) / before) * 100);
    const label = this.period() === 'today' ? 'last ' + new Date(`${daysBefore(this.biz.today(), 7)}T12:00:00Z`).toLocaleDateString('en-ZA', { weekday: 'long' }) : 'previous period';
    return { pct, label };
  });
  private readonly trendStats = liveStats(this.biz, () => periodRange(this.period() === 'month' ? 'month' : 'week', this.biz.today()));
  protected readonly totals = computed(() => (this.period() === 'shift' ? this.shiftTotals() : sumStats(this.stats.normalised())));
  protected readonly profit = computed(() => profitSummary(this.totals()));
  protected readonly avgOrder = computed(() => (this.totals().orders ? Math.round(this.profit().netRevenueCents / this.totals().orders) : 0));
  protected readonly bestSellers = computed(() =>
    Object.entries(this.totals().products)
      .map(([id, p]) => ({ id, ...p }))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 6),
  );

  protected readonly session = liveDoc<CashSession>(() => {
    const s = this.biz.openShift();
    return s ? this.biz.docRef('cashSessions', s.cashSessionId) : null;
  });
  protected readonly expected = computed(() => {
    const c = this.session.data();
    return c ? expectedCash(c) : 0;
  });

  private readonly ingredients = liveQuery<Ingredient>(() => query(this.biz.col('ingredients'), where('active', '==', true)));
  protected readonly lowStock = computed(() => this.ingredients.data().filter(isLowStock));
  protected readonly pending = liveQuery<{ id: string }>(() => query(this.biz.col('approvals'), where('status', '==', 'pending'), limit(50)));
  protected readonly recentSales = liveQuery<Sale>(() => query(this.biz.col('sales'), orderBy('createdAt', 'desc'), limit(8)));
  protected readonly activity = liveQuery<AuditLog>(() => query(this.biz.col('auditLogs'), orderBy('at', 'desc'), limit(10)));
  protected readonly alerts = liveQuery<AppNotification>(() =>
    query(this.biz.col('notifications'), where('read', '==', false), where('severity', '==', 'critical'), limit(3)),
  );

  protected readonly trendChart = computed<ChartConfiguration>(() => {
    const r = periodRange(this.period() === 'month' ? 'month' : 'week', this.biz.today());
    const byDay = new Map(this.trendStats.normalised().map((d) => [d.dayKey, d]));
    const days = dayRange(r.from, r.to);
    const sales = days.map((d) => (byDay.has(d) ? profitSummary(byDay.get(d)!).netRevenueCents / 100 : 0));
    const profit = days.map((d) => (byDay.has(d) ? profitSummary(byDay.get(d)!).grossProfitCents / 100 : 0));
    return {
      type: 'bar',
      data: {
        labels: days.map((d) => d.slice(5)),
        datasets: [
          { label: 'Sales', data: sales, backgroundColor: CHART_COLOURS.sales, borderRadius: 4 },
          { label: 'Gross profit', data: profit, backgroundColor: CHART_COLOURS.profit, borderRadius: 4 },
        ],
      },
      options: { plugins: { legend: { position: 'bottom' } }, scales: { y: { beginAtZero: true, ticks: { callback: (v) => `R${v}` } } } },
    };
  });

  protected describe(a: AuditLog): string {
    const d = a.details as Record<string, number | string | undefined>;
    const r = (c: unknown) => (typeof c === 'number' ? `R${(c / 100).toFixed(2)}` : '');
    switch (a.action) {
      case 'sale.recorded':
        return `sold receipt #${d['receiptNo']} for ${r(d['totalCents'])} (${d['method']})`;
      case 'shift.opened':
        return `opened the shift with a ${r(d['openingFloatCents'])} float`;
      case 'shift.closed':
        return `closed the shift – ${d['differenceCents'] === 0 ? 'cash balanced' : `cash difference ${r(d['differenceCents'])}`}`;
      case 'expense.submitted':
        return `submitted a ${r(d['amountCents'])} ${d['category']} expense`;
      case 'refund.requested':
        return `requested a ${r(d['amountCents'])} refund`;
      case 'stock.wastage':
        return `recorded wastage worth ${r(d['valueCents'])}: ${d['reason']}`;
      case 'cash.payout':
        return `took ${r(d['amountCents'])} out of the till: ${d['reason']}`;
      case 'approval.approved':
      case 'approval.rejected':
        return `${a.action.endsWith('approved') ? 'approved' : 'rejected'} a ${d['type']} of ${r(d['amountCents'])}`;
      default:
        return a.action.replace('.', ' ');
    }
  }
}
