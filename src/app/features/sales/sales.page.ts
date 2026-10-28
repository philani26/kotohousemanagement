import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe, UpperCasePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { limit, orderBy, query, where } from 'firebase/firestore';
import { ORDER_STATUSES, Order, OrderStatus, Sale } from '@shared/models';
import { centsToRandString } from '@shared/money';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { BusinessService } from '../../core/business.service';
import { liveQuery } from '../../core/live';
import { ToastService } from '../../core/toast.service';
import { TsPipe, ZarPipe } from '../../shared/pipes';

@Component({
  selector: 'app-sales',
  imports: [FormsModule, DatePipe, UpperCasePipe, ZarPipe, TsPipe],
  template: `
    <div class="page-head">
      <h1>Sales</h1>
      @if (biz.myOpenShift()) {
        <div class="seg">
          <button [class.on]="view() === 'shift'" (click)="setView('shift')">This shift</button>
          <button [class.on]="view() === 'earlier'" (click)="setView('earlier')">{{ auth.isOwner() ? 'By day' : 'Earlier sales' }}</button>
        </div>
      }
      @if (auth.isOwner() && view() === 'earlier') {
        <input type="date" [ngModel]="day()" (ngModelChange)="day.set($event)" style="width: auto" />
      }
      @if (auth.isOwner()) {
        <button class="btn small" (click)="downloadCsv()" [disabled]="!sales.data().length">⬇ CSV</button>
      }
    </div>

    @if (view() === 'shift' && biz.myOpenShift(); as s) {
      <p class="muted small" style="margin-top: -.5rem">Sales since the shift opened at {{ s.openedAt | ts | date: 'HH:mm' }}. Each new shift starts from zero.</p>
    }

    <div class="stats">
      <div class="stat brand"><div class="label">Total</div><div class="value">{{ totals().net | zar }}</div><div class="sub">{{ totals().count }} orders</div></div>
      <div class="stat"><div class="label">Cash</div><div class="value">{{ totals().cash | zar }}</div></div>
      <div class="stat"><div class="label">Card</div><div class="value">{{ totals().card | zar }}</div></div>
      <div class="stat"><div class="label">EFT</div><div class="value">{{ totals().eft | zar }}</div></div>
    </div>

    <div class="card">
      @if (!auth.isOwner()) {
        <p class="muted small">{{ view() === 'shift' ? 'Your sales on this shift.' : 'Your sales from the last few days.' }} Refunds must be approved by the owner.</p>
      }
      <div class="list">
        @for (s of sales.data(); track s.id) {
          <div class="list-item">
            <div class="main">
              <div class="row">
                <span class="title">#{{ s.receiptNo }} · {{ s.totalCents | zar }}</span>
                <span class="badge" [class.info]="s.payment.method !== 'cash'">{{ s.payment.method | uppercase }}</span>
                @if (s.status === 'refunded') {
                  <span class="badge bad">Refunded</span>
                } @else if (s.status === 'refundPending') {
                  <span class="badge warn">Refund pending</span>
                }
                @if (s.offline) {
                  <span class="badge warn" title="Rung up without internet and sent later">Offline · {{ s.soldAt | ts | date: 'HH:mm' }}</span>
                }
                @if (s.discountCents) {
                  <span class="badge warn">−{{ s.discountCents | zar }}</span>
                }
                @if (auth.isOwner() && s.payment.method !== 'cash') {
                  <span class="badge" [class.ok]="s.payment.verified">{{ s.payment.verified ? 'Verified' : 'Not verified' }}</span>
                }
              </div>
              <div class="small muted">
                {{ s.createdAt | ts | date: 'd MMM HH:mm' }} · {{ s.employeeName }} ·
                @for (l of s.lines; track l.productId; let last = $last) {
                  {{ l.quantity }}× {{ l.name }}{{ last ? '' : ', ' }}
                }
              </div>
              @if (orderFor().get(s.id); as o) {
                <div class="order-progress" [attr.aria-label]="'Order status: ' + o.status">
                  <span class="step done">Paid {{ o.createdAtMillis | date: 'HH:mm' }}</span>
                  <span class="step" [class.done]="o.preparingAt || reached(o.status, 'preparing')" [class.now]="o.status === 'preparing'">
                    Preparing{{ o.preparingAt ? ' ' + (o.preparingAt | date: 'HH:mm') : '' }}
                  </span>
                  <span class="step" [class.done]="reached(o.status, 'ready')" [class.now]="o.status === 'ready'">
                    Ready{{ o.readyAt ? ' ' + (o.readyAt | date: 'HH:mm') : '' }}
                  </span>
                  <span class="step" [class.done]="o.status === 'collected'">
                    Collected{{ o.collectedAt ? ' ' + (o.collectedAt | date: 'HH:mm') : '' }}
                  </span>
                </div>
                @if (o.note) {
                  <div class="tiny">📝 {{ o.note }}</div>
                }
              }
              @if (s.payment.method === 'cash' && s.payment.amountReceivedCents) {
                <div class="tiny">Received {{ s.payment.amountReceivedCents | zar }}, change {{ s.payment.changeCents ?? 0 | zar }}</div>
              }
              @if (s.payment.reference) {
                <div class="tiny">Ref: {{ s.payment.reference }}</div>
              }
              @if (s.discountReason) {
                <div class="tiny">Discount: {{ s.discountReason }}</div>
              }
              @if (s.refund) {
                <div class="tiny">Refund reason: {{ s.refund.reason }}</div>
              }
            </div>
            <div class="stack" style="gap: .35rem">
              @if (s.status === 'completed') {
                <button class="btn small" (click)="refundFor.set(s)">Refund</button>
              }
              @if (auth.isOwner() && s.payment.method !== 'cash' && s.status !== 'refunded') {
                <button class="btn small" (click)="verify(s)">{{ s.payment.verified ? 'Unverify' : 'Verify' }}</button>
              }
            </div>
          </div>
        } @empty {
          <p class="empty">{{ sales.loading() ? 'Loading…' : 'No sales yet' }}</p>
        }
      </div>
    </div>

    @if (refundFor(); as s) {
      <div class="dialog-backdrop" (click)="refundFor.set(null)">
        <form class="dialog" (click)="$event.stopPropagation()" (ngSubmit)="refund(s)">
          <h2>Refund receipt #{{ s.receiptNo }}</h2>
          <p>{{ s.totalCents | zar }} paid by {{ s.payment.method }}.</p>
          @if (!auth.isOwner()) {
            <p class="muted small">The owner must approve this refund. Do not hand back money until it is approved.</p>
          } @else if (s.payment.method === 'card') {
            <p class="muted small">Remember to process the refund on the card machine too.</p>
          }
          <label class="field"><span>Reason</span><textarea name="reason" [(ngModel)]="reason" required></textarea></label>
          <div class="row">
            <button type="button" class="btn" (click)="refundFor.set(null)">Cancel</button>
            <button class="btn danger" [disabled]="busy()">{{ auth.isOwner() ? 'Refund now' : 'Request refund' }}</button>
          </div>
        </form>
      </div>
    }
  `,
})
export class SalesPage {
  protected readonly auth = inject(AuthService);
  protected readonly biz = inject(BusinessService);
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  protected readonly day = signal(this.biz.today());
  protected readonly refundFor = signal<Sale | null>(null);
  protected readonly busy = signal(false);
  protected reason = '';

  /** 'shift' = only the open shift, so every new shift starts from zero */
  private readonly chosenView = signal<'shift' | 'earlier' | null>(null);
  protected readonly view = computed(() => {
    const v = this.chosenView() ?? (this.biz.myOpenShift() ? 'shift' : 'earlier');
    return v === 'shift' && !this.biz.myOpenShift() ? 'earlier' : v;
  });
  protected setView(v: 'shift' | 'earlier') {
    this.chosenView.set(v);
  }

  private readonly rawSales = liveQuery<Sale>(() => {
    const shift = this.view() === 'shift' ? this.biz.myOpenShift() : null;
    if (shift) {
      // Security rules let employees list only their own sales, so filter on both.
      const base = query(this.biz.col('sales'), where('shiftId', '==', shift.id));
      return this.auth.isOwner() ? base : query(base, where('employeeId', '==', this.auth.uid()));
    }
    return this.auth.isOwner()
      ? query(this.biz.col('sales'), where('dayKey', '==', this.day()), orderBy('createdAt', 'desc'))
      : query(this.biz.col('sales'), where('employeeId', '==', this.auth.uid()), orderBy('createdAt', 'desc'), limit(60));
  });
  /** newest first (the shift query has no orderBy, to avoid needing another index) */
  protected readonly sales = {
    ...this.rawSales,
    data: computed(() => [...this.rawSales.data()].sort((a, b) => (b.createdAt?.toMillis() ?? Date.now()) - (a.createdAt?.toMillis() ?? Date.now()))),
  };

  /** Kitchen tickets for the sales on screen (staff may read all tickets; days limited to 30 for the 'in' query). */
  private readonly orderList = liveQuery<Order>(() => {
    const days = [...new Set(this.sales.data().map((s) => s.dayKey))].slice(0, 30);
    return days.length ? query(this.biz.col('orders'), where('dayKey', 'in', days)) : null;
  });
  protected readonly orderFor = computed(() => new Map(this.orderList.data().map((o) => [o.id, o])));

  protected reached(status: OrderStatus, step: OrderStatus) {
    return ORDER_STATUSES.indexOf(status) >= ORDER_STATUSES.indexOf(step);
  }

  protected readonly totals = computed(() => {
    const t = { net: 0, count: 0, cash: 0, card: 0, eft: 0 };
    for (const s of this.sales.data()) {
      if (s.status === 'refunded') continue;
      t.net += s.totalCents;
      t.count++;
      t[s.payment.method] += s.totalCents;
    }
    return t;
  });

  async refund(s: Sale) {
    this.busy.set(true);
    try {
      await this.api.call('requestRefund', { saleId: s.id, reason: this.reason });
      this.toast.ok(this.auth.isOwner() ? 'Refund recorded' : 'Refund sent to the owner for approval');
      this.refundFor.set(null);
      this.reason = '';
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }

  downloadCsv() {
    const r = centsToRandString;
    const header = ['Receipt', 'Time', 'Cashier', 'Items', 'Subtotal', 'Discount', 'Total', 'Method', 'Reference', 'Status', 'Verified', 'Offline', 'Ingredient cost'];
    const rows = this.sales.data().map((s) => [
      s.receiptNo,
      (s.soldAt ?? s.createdAt)?.toDate().toLocaleString('en-ZA') ?? '',
      s.employeeName,
      s.lines.map((l) => `${l.quantity}x ${l.name}`).join('; '),
      r(s.subtotalCents),
      r(s.discountCents),
      r(s.totalCents),
      s.payment.method,
      s.payment.reference ?? '',
      s.status,
      s.payment.verified ? 'yes' : 'no',
      s.offline ? 'yes' : 'no',
      r(s.costCents),
    ]);
    const csv = [header, ...rows].map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `kota-sales-${this.day()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async verify(s: Sale) {
    try {
      await this.api.call('verifyPayment', { saleId: s.id, verified: !s.payment.verified });
    } catch (err) {
      this.toast.error(err);
    }
  }
}
