import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { orderBy, query, where } from 'firebase/firestore';
import { Order, OrderStatus } from '@shared/models';
import { BusinessService } from '../../core/business.service';
import { liveQuery } from '../../core/live';
import { OrdersService } from '../../core/orders.service';

interface Ticket extends Order {
  /** position in today's queue, 1 = first order of the day */
  number: number;
  waitingMin: number;
}

const COLUMNS: { status: Exclude<OrderStatus, 'collected'>; title: string }[] = [
  { status: 'new', title: 'New' },
  { status: 'preparing', title: 'Preparing' },
  { status: 'ready', title: 'Ready to collect' },
];

/** Live order queue: tickets in the order customers paid, moved New → Preparing → Ready → Collected. */
@Component({
  selector: 'app-orders',
  imports: [DatePipe, RouterLink],
  template: `
    <div class="page-head">
      <h1>Orders</h1>
      <div class="seg">
        <button [class.on]="view() === 'active'" (click)="view.set('active')">In progress ({{ active().length }})</button>
        <button [class.on]="view() === 'collected'" (click)="view.set('collected')">Collected ({{ collected().length }})</button>
      </div>
    </div>

    @if (view() === 'active') {
      @if (!active().length) {
        <div class="card empty">
          {{ list.loading() ? 'Loading…' : 'No orders waiting.' }}
          <br /><a routerLink="/pos">Go to Sell</a>
        </div>
      }
      <div class="order-board">
        @for (col of columns; track col.status) {
          <section>
            <h2 class="order-col-title">{{ col.title }} <span class="badge">{{ byStatus()[col.status].length }}</span></h2>
            @for (t of byStatus()[col.status]; track t.id) {
              <article class="card order-ticket" [class.late]="t.waitingMin >= 10 && t.status !== 'ready'"
                [class.very-late]="t.waitingMin >= 20 && t.status !== 'ready'" [class.ready]="t.status === 'ready'">
                <div class="row between">
                  <strong class="order-no">Order {{ t.number }}</strong>
                  <span class="tiny">
                    {{ t.receiptNo ? '#' + t.receiptNo : 'offline' }} · {{ t.createdAtMillis | date: 'HH:mm' }} · {{ t.waitingMin }} min
                  </span>
                </div>
                <ul class="order-lines">
                  @for (l of t.lines; track $index) {
                    <li><strong>{{ l.quantity }}×</strong> {{ l.name }}</li>
                  }
                </ul>
                @if (t.note) {
                  <div class="alert warn small" style="margin: 0 0 .6rem">📝 {{ t.note }}</div>
                }
                <div class="row">
                  @switch (t.status) {
                    @case ('new') {
                      <button class="btn primary block xl" (click)="move(t, 'preparing')">Start preparing</button>
                    }
                    @case ('preparing') {
                      <button class="btn ok block xl" (click)="move(t, 'ready')">✓ Ready</button>
                      <button class="btn ghost small" (click)="move(t, 'new')">Undo</button>
                    }
                    @case ('ready') {
                      <button class="btn dark block xl" (click)="move(t, 'collected')">✓ Collected</button>
                      <button class="btn ghost small" (click)="move(t, 'preparing')">Undo</button>
                    }
                  }
                </div>
              </article>
            } @empty {
              <p class="tiny" style="padding: 0 .25rem">Nothing here</p>
            }
          </section>
        }
      </div>
    } @else {
      <div class="card">
        <div class="list">
          @for (t of collected(); track t.id) {
            <div class="list-item">
              <div class="main">
                <div class="title">Order {{ t.number }} {{ t.receiptNo ? '· #' + t.receiptNo : '' }}</div>
                <div class="small muted">
                  @for (l of t.lines; track $index; let last = $last) {
                    {{ l.quantity }}× {{ l.name }}{{ last ? '' : ', ' }}
                  }
                </div>
                <div class="tiny">
                  Paid {{ t.createdAtMillis | date: 'HH:mm' }}
                  @if (t.readyAt) {
                    · ready after {{ minutes(t.createdAtMillis, t.readyAt) }} min
                  }
                  @if (t.collectedAt) {
                    · collected {{ t.collectedAt | date: 'HH:mm' }}
                  }
                </div>
              </div>
              <button class="btn small ghost" (click)="move(t, 'ready')">Undo</button>
            </div>
          } @empty {
            <p class="empty">No collected orders today</p>
          }
        </div>
        @if (avgPrep(); as avg) {
          <p class="small" style="margin-top: .75rem">Average time from payment to ready today: <strong>{{ avg }} min</strong></p>
        }
      </div>
    }
  `,
})
export class OrdersPage {
  private readonly biz = inject(BusinessService);
  private readonly orders = inject(OrdersService);
  protected readonly columns = COLUMNS;
  protected readonly view = signal<'active' | 'collected'>('active');
  /** ticks every 30 s so waiting times stay current */
  private readonly now = signal(Date.now());

  protected readonly list = liveQuery<Order>(() =>
    query(this.biz.col('orders'), where('dayKey', '==', this.biz.today()), orderBy('createdAtMillis')),
  );

  private readonly tickets = computed<Ticket[]>(() => {
    const now = this.now();
    return this.list.data().map((o, i) => ({ ...o, number: i + 1, waitingMin: Math.max(0, Math.floor((now - o.createdAtMillis) / 60_000)) }));
  });
  protected readonly active = computed(() => this.tickets().filter((t) => t.status !== 'collected'));
  protected readonly collected = computed(() =>
    this.tickets()
      .filter((t) => t.status === 'collected')
      .sort((a, b) => (b.collectedAt ?? 0) - (a.collectedAt ?? 0)),
  );
  protected readonly byStatus = computed(() => {
    const groups: Record<string, Ticket[]> = { new: [], preparing: [], ready: [] };
    for (const t of this.active()) groups[t.status].push(t);
    return groups;
  });
  protected readonly avgPrep = computed(() => {
    const done = this.tickets().filter((t) => t.readyAt);
    if (!done.length) return null;
    return Math.round(done.reduce((s, t) => s + (t.readyAt! - t.createdAtMillis), 0) / done.length / 60_000);
  });

  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), 30_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  move(t: Order, status: OrderStatus) {
    this.orders.setStatus(t, status);
  }

  minutes(from: number, to: number) {
    return Math.max(0, Math.round((to - from) / 60_000));
  }
}
