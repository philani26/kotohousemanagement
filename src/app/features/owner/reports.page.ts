import { Component, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChartConfiguration } from 'chart.js';
import { limit, orderBy, query, where } from 'firebase/firestore';
import { dayRange, normaliseStats, profitSummary, sumStats } from '@shared/domain';
import { CashSession, Expense, StockMovement } from '@shared/models';
import { centsToRandString } from '@shared/money';
import { BusinessService } from '../../core/business.service';
import { liveQuery } from '../../core/live';
import { ChartComponent } from '../../shared/chart.component';
import { ZarPipe } from '../../shared/pipes';
import { CHART_COLOURS, Period, daysBefore, liveStats, periodRange } from './stats';

@Component({
  selector: 'app-reports',
  imports: [FormsModule, DecimalPipe, ZarPipe, ChartComponent],
  template: `
    <div class="page-head">
      <h1>Reports</h1>
      <div class="row no-print">
        <button class="btn small" (click)="downloadCsv()">⬇ CSV</button>
        <button class="btn small" (click)="print()">🖨 Print / PDF</button>
      </div>
    </div>

    <div class="card no-print">
      <div class="row">
        <div class="seg">
          <button [class.on]="period() === 'today'" (click)="setPeriod('today')">Day</button>
          <button [class.on]="period() === 'week'" (click)="setPeriod('week')">Week</button>
          <button [class.on]="period() === 'month'" (click)="setPeriod('month')">Month</button>
        </div>
        <label class="row small">From <input type="date" [ngModel]="from()" (ngModelChange)="from.set($event); period.set(null)" style="width: auto" /></label>
        <label class="row small">To <input type="date" [ngModel]="to()" (ngModelChange)="to.set($event); period.set(null)" [max]="biz.today()" style="width: auto" /></label>
      </div>
    </div>

    <h2>{{ biz.settings().businessName }} · {{ from() }} to {{ to() }}</h2>

    <div class="grid-2">
      <div class="card">
        <h2>Profit statement (estimated)</h2>
        <div class="kv">
          <span>Gross sales (after discounts)</span><span>{{ totals().grossSalesCents | zar }}</span>
          <span>− Refunds ({{ totals().refundCount }})</span><span>{{ totals().refundsCents | zar }}</span>
          <span class="total">Revenue</span><span class="total">{{ p().netRevenueCents | zar }}</span>
          <span>− Cost of ingredients sold</span><span>{{ p().costOfSalesCents | zar }}</span>
          <span class="total">Gross profit · {{ p().grossMarginPercent }}%</span><span class="total">{{ p().grossProfitCents | zar }}</span>
          <span>− Wastage</span><span>{{ totals().wastageCostCents | zar }}</span>
          <span>− Staff meals & free items</span><span>{{ totals().staffMealCostCents | zar }}</span>
          <span>− Stock count losses</span><span>{{ -totals().stockAdjustmentCents | zar }}</span>
          <span>− Operating expenses</span><span>{{ totals().operatingExpensesCents | zar }}</span>
          <span class="total">Operating profit</span>
          <span class="total" [style.color]="p().operatingProfitCents < 0 ? 'var(--bad)' : 'var(--ok)'">{{ p().operatingProfitCents | zar }}</span>
        </div>
        <p class="tiny" style="margin-top: .75rem">
          Discounts given: {{ totals().discountsCents | zar }}. Stock bought: {{ totals().inventoryPurchasesCents | zar }} (stock is an asset – it becomes cost when used,
          so it is not subtracted again here). Ingredient costs come from recipes; keep them up to date for accurate profit.
        </p>
      </div>

      <div class="card">
        <h2>Sales by payment method</h2>
        <app-chart [config]="methodChart()" [height]="200" />
        <div class="kv" style="margin-top: .75rem">
          <span>Cash</span><span>{{ totals().byMethod.cash | zar }}</span>
          <span>Card</span><span>{{ totals().byMethod.card | zar }}</span>
          <span>EFT</span><span>{{ totals().byMethod.eft | zar }}</span>
          <span class="total">Orders</span><span class="total">{{ totals().orders }}</span>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Daily sales, profit and expenses</h2>
      <app-chart [config]="dailyChart()" [height]="260" />
    </div>

    <div class="grid-2">
      <div class="card">
        <h2>Best-selling products</h2>
        <table>
          <thead><tr><th>Product</th><th class="r">Qty</th><th class="r">Sales</th></tr></thead>
          <tbody>
            @for (row of products(); track row.id) {
              <tr><td>{{ row.name }}</td><td class="r">{{ row.qty }}</td><td class="r">{{ row.revenueCents | zar }}</td></tr>
            } @empty {
              <tr><td colspan="3" class="empty">No sales</td></tr>
            }
          </tbody>
        </table>
      </div>

      <div class="card">
        <h2>Approved expenses by category</h2>
        <table>
          <thead><tr><th>Category</th><th class="r">Count</th><th class="r">Total</th></tr></thead>
          <tbody>
            @for (row of expenseRows(); track row.category) {
              <tr><td>{{ row.category }}</td><td class="r">{{ row.count }}</td><td class="r">{{ row.total | zar }}</td></tr>
            } @empty {
              <tr><td colspan="3" class="empty">No approved expenses</td></tr>
            }
          </tbody>
        </table>
        @if (pendingExpenses()) {
          <p class="tiny" style="margin-top: .5rem">{{ pendingExpenses() | zar }} still waiting for approval.</p>
        }
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <h2>Cash-ups: expected vs counted</h2>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Day</th><th>Staff</th><th class="r">Expected</th><th class="r">Counted</th><th class="r">Diff</th></tr></thead>
            <tbody>
              @for (c of sessions.data(); track c.id) {
                <tr>
                  <td>{{ c.dayKey }}</td>
                  <td>{{ c.employeeName }}</td>
                  <td class="r">{{ c.expectedCashCents ?? null | zar }}</td>
                  <td class="r">{{ c.countedCashCents ?? null | zar }}</td>
                  <td class="r" [style.color]="(c.differenceCents ?? 0) < 0 ? 'var(--bad)' : null">
                    {{ c.status === 'open' ? 'open' : (c.differenceCents ?? 0 | zar) }}
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="5" class="empty">No cash-ups</td></tr>
              }
            </tbody>
          </table>
        </div>
        <p class="small" style="margin-top: .5rem">Net cash difference: <strong>{{ cashDiff() | zar }}</strong></p>
      </div>

      <div class="card">
        <h2>Stock losses & ingredient use</h2>
        <table>
          <thead><tr><th>Item</th><th class="r">Used in sales</th><th class="r">Wasted / given</th><th class="r">Loss value</th></tr></thead>
          <tbody>
            @for (row of stockRows(); track row.name) {
              <tr>
                <td>{{ row.name }}</td>
                <td class="r">{{ row.sold | number: '1.0-2' }}</td>
                <td class="r">{{ row.lost | number: '1.0-2' }}</td>
                <td class="r">{{ row.lossValue | zar }}</td>
              </tr>
            } @empty {
              <tr><td colspan="4" class="empty">No stock movements</td></tr>
            }
          </tbody>
        </table>
      </div>
    </div>
  `,
})
export class ReportsPage {
  protected readonly biz = inject(BusinessService);
  protected readonly period = signal<Period | null>('week');
  protected readonly from = signal(daysBefore(this.biz.today(), 6));
  protected readonly to = signal(this.biz.today());
  private readonly range = computed(() => ({ from: this.from(), to: this.to() }));

  private readonly stats = liveStats(this.biz, () => this.range());
  protected readonly totals = computed(() => sumStats(this.stats.normalised()));
  protected readonly p = computed(() => profitSummary(this.totals()));

  private readonly expenses = liveQuery<Expense>(() =>
    query(this.biz.col('expenses'), where('date', '>=', this.from()), where('date', '<=', this.to()), limit(1000)),
  );
  protected readonly sessions = liveQuery<CashSession>(() =>
    query(this.biz.col('cashSessions'), where('dayKey', '>=', this.from()), where('dayKey', '<=', this.to()), orderBy('dayKey', 'desc'), limit(200)),
  );
  private readonly movements = liveQuery<StockMovement>(() =>
    query(this.biz.col('stockMovements'), where('dayKey', '>=', this.from()), where('dayKey', '<=', this.to()), limit(5000)),
  );

  protected readonly products = computed(() =>
    Object.entries(this.totals().products)
      .map(([id, p]) => ({ id, ...p }))
      .sort((a, b) => b.qty - a.qty),
  );
  protected readonly expenseRows = computed(() => {
    const map = new Map<string, { category: string; count: number; total: number }>();
    for (const e of this.expenses.data().filter((x) => x.status === 'approved')) {
      const row = map.get(e.category) ?? { category: e.category, count: 0, total: 0 };
      row.count++;
      row.total += e.amountCents;
      map.set(e.category, row);
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  });
  protected readonly pendingExpenses = computed(() =>
    this.expenses.data().filter((e) => e.status === 'submitted').reduce((s, e) => s + e.amountCents, 0),
  );
  protected readonly cashDiff = computed(() => this.sessions.data().reduce((s, c) => s + (c.differenceCents ?? 0), 0));
  protected readonly stockRows = computed(() => {
    const map = new Map<string, { name: string; sold: number; lost: number; lossValue: number }>();
    for (const m of this.movements.data()) {
      if (!['sale', 'wastage', 'staffMeal', 'complimentary', 'adjustment'].includes(m.type)) continue;
      const row = map.get(m.ingredientId) ?? { name: m.ingredientName, sold: 0, lost: 0, lossValue: 0 };
      if (m.type === 'sale') row.sold += -m.qtyChange;
      else if (m.type === 'adjustment') row.lossValue -= Math.sign(m.qtyChange) * m.valueCents;
      else {
        row.lost += -m.qtyChange;
        row.lossValue += m.valueCents;
      }
      map.set(m.ingredientId, row);
    }
    return [...map.values()].sort((a, b) => b.lossValue - a.lossValue);
  });

  protected readonly methodChart = computed<ChartConfiguration>(() => ({
    type: 'doughnut',
    data: {
      labels: ['Cash', 'Card', 'EFT'],
      datasets: [
        {
          data: [this.totals().byMethod.cash / 100, this.totals().byMethod.card / 100, this.totals().byMethod.eft / 100],
          backgroundColor: [CHART_COLOURS.cash, CHART_COLOURS.card, CHART_COLOURS.eft],
        },
      ],
    },
    options: { plugins: { legend: { position: 'right' } } },
  }));

  protected readonly dailyChart = computed<ChartConfiguration>(() => {
    const byDay = new Map(this.stats.normalised().map((d) => [d.dayKey, d]));
    const days = dayRange(this.from(), this.to());
    const series = (fn: (s: ReturnType<typeof profitSummary>) => number) =>
      days.map((d) => (byDay.has(d) ? fn(profitSummary(normaliseStats(byDay.get(d)!))) / 100 : 0));
    return {
      type: 'line',
      data: {
        labels: days.map((d) => d.slice(5)),
        datasets: [
          { label: 'Revenue', data: series((p) => p.netRevenueCents), borderColor: CHART_COLOURS.sales, backgroundColor: CHART_COLOURS.sales, tension: 0.3 },
          { label: 'Gross profit', data: series((p) => p.grossProfitCents), borderColor: CHART_COLOURS.profit, backgroundColor: CHART_COLOURS.profit, tension: 0.3 },
          { label: 'Expenses', data: series((p) => p.operatingExpensesCents), borderColor: CHART_COLOURS.expenses, backgroundColor: CHART_COLOURS.expenses, tension: 0.3 },
        ],
      },
      options: { plugins: { legend: { position: 'bottom' } }, scales: { y: { ticks: { callback: (v) => `R${v}` } } } },
    };
  });

  setPeriod(p: Period) {
    const r = periodRange(p, this.biz.today());
    this.period.set(p);
    this.from.set(r.from);
    this.to.set(r.to);
  }

  print() {
    window.print();
  }

  downloadCsv() {
    const byDay = new Map(this.stats.normalised().map((d) => [d.dayKey, d]));
    const header = ['Date', 'Orders', 'Gross sales', 'Discounts', 'Refunds', 'Revenue', 'Cash', 'Card', 'EFT', 'Cost of sales', 'Gross profit', 'Wastage', 'Staff meals', 'Stock adjustments', 'Operating expenses', 'Operating profit', 'Stock purchased'];
    const rows = dayRange(this.from(), this.to()).map((d) => {
      const s = normaliseStats(byDay.get(d) ?? { dayKey: d });
      const p = profitSummary(s);
      const r = centsToRandString;
      return [d, s.orders, r(s.grossSalesCents), r(s.discountsCents), r(s.refundsCents), r(p.netRevenueCents), r(s.byMethod.cash), r(s.byMethod.card), r(s.byMethod.eft), r(p.costOfSalesCents), r(p.grossProfitCents), r(s.wastageCostCents), r(s.staffMealCostCents), r(s.stockAdjustmentCents), r(s.operatingExpensesCents), r(p.operatingProfitCents), r(s.inventoryPurchasesCents)];
    });
    const csv = [header, ...rows].map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `kota-report-${this.from()}-to-${this.to()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
}
