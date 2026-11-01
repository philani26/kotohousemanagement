import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { orderBy, query, where } from 'firebase/firestore';
import { Order, OrderStatus } from '@shared/models';
import { BusinessService } from '../core/business.service';
import { liveQuery } from '../core/live';
import { OrdersService } from '../core/orders.service';
import { PendingChargeService } from '../core/pending-charge.service';
import { AuthService } from '../core/auth.service';
import { ZarPipe } from './pipes';

const NEXT: Record<Exclude<OrderStatus, 'collected'>, { to: OrderStatus; label: string; cls: string }> = {
  new: { to: 'preparing', label: 'Start preparing', cls: 'primary' },
  preparing: { to: 'ready', label: 'Mark as ready', cls: 'ok' },
  ready: { to: 'collected', label: 'Hand over', cls: 'dark' },
};
const BACK: Partial<Record<OrderStatus, OrderStatus>> = { preparing: 'new', ready: 'preparing' };
/** till orders: 1, 2, 3… in paying order; WhatsApp orders: W1, W2… */
export function orderLabel(o: Order, tillPosition: number): string {
  return o.source === 'whatsapp' ? `W${o.ticketNo ?? '?'}` : String(tillPosition);
}

const LABEL: Record<OrderStatus, string> = { new: 'New', preparing: 'Preparing', ready: 'Ready', collected: 'Collected' };

/** Compact live queue of today's open orders, for the Sell page. */
@Component({
  selector: 'app-order-queue',
  imports: [DatePipe, RouterLink, ZarPipe],
  template: `
    <div class="card-head">
      <h2>Order queue</h2>
      <a routerLink="/orders" class="small">Full board</a>
    </div>
    @for (t of active(); track t.id) {
      <div class="queue-row" [class.late]="t.waitingMin >= 10 && t.status !== 'ready'" [class.very-late]="t.waitingMin >= 20 && t.status !== 'ready'">
        <div class="row between">
          <strong>Order {{ t.label }}</strong>
          <span class="row" style="gap: .3rem">
            @if (t.source === 'whatsapp') {
              <span class="badge wa" title="Ordered on WhatsApp">💬 {{ t.customerName }}</span>
            }
            <span class="badge" [class.warn]="t.status === 'preparing'" [class.ok]="t.status === 'ready'">{{ label[t.status] }}</span>
          </span>
        </div>
        <div class="small">
          @for (l of t.lines; track $index; let last = $last) {
            {{ l.quantity }}× {{ l.name }}{{ last ? '' : ', ' }}
          }
        </div>
        @if (t.note) {
          <div class="tiny">📝 {{ t.note }}</div>
        }
        @if (t.source === 'whatsapp') {
          <div class="row between" style="margin-top: .35rem">
            @if (t.paid) {
              <span class="badge ok">Paid</span>
            } @else {
              <span class="tiny">To pay at collection: <strong>{{ t.totalCents ?? 0 | zar }}</strong></span>
              <button class="btn small primary" (click)="pending.charge(t)">Charge</button>
            }
          </div>
        }
        <div class="row between" style="margin-top: .4rem">
          <span class="tiny">{{ t.createdAtMillis | date: 'HH:mm' }} · {{ t.waitingMin }} min</span>
          <div class="row" style="gap: .3rem">
            @if (back[t.status]; as b) {
              <button class="btn small ghost" (click)="move(t, b)">Undo</button>
            }
            @if (next(t); as n) {
              <button [class]="'btn small ' + n.cls" (click)="move(t, n.to)">{{ n.label }}</button>
            }
          </div>
        </div>
      </div>
    } @empty {
      <p class="empty small">{{ list.loading() ? 'Loading…' : 'No orders waiting' }}</p>
    }
  `,
})
export class OrderQueueComponent {
  private readonly biz = inject(BusinessService);
  private readonly orders = inject(OrdersService);
  protected readonly pending = inject(PendingChargeService);
  private readonly kitchen = inject(AuthService).isKitchen;
  protected readonly label = LABEL;
  protected readonly back = BACK;
  private readonly now = signal(Date.now());

  protected readonly list = liveQuery<Order>(() =>
    query(this.biz.col('orders'), where('dayKey', '==', this.biz.today()), orderBy('createdAtMillis')),
  );
  /** open orders, oldest first, numbered by their place in today's queue */
  protected readonly active = computed(() => {
    const now = this.now();
    return this.list
      .data()
      .map((o, i, all) => ({
        ...o,
        label: orderLabel(o, all.slice(0, i + 1).filter((x) => x.source !== 'whatsapp').length),
        waitingMin: Math.max(0, Math.floor((now - o.createdAtMillis) / 60_000)),
      }))
      .filter((o) => o.status !== 'collected');
  });

  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), 30_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected next(o: Order) {
    // unpaid WhatsApp orders are charged before they are handed over
    if (o.status === 'collected' || (o.status === 'ready' && o.source === 'whatsapp' && !o.paid)) return null;
    return NEXT[o.status];
  }

  protected move(o: Order, status: OrderStatus) {
    this.orders.setStatus(o, status);
  }
}
