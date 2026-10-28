import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { ApiRequest } from '@shared/api';
import { ApiError, ApiService } from './api.service';
import { AuthService } from './auth.service';
import { OrdersService } from './orders.service';

export interface QueuedSale {
  /** includes the shop it was rung up in, so it syncs there even after a shop switch */
  request: ApiRequest<'recordSale'> & { businessId?: string };
  queuedAt: number;
  attempts: number;
  /** set when the server refused the sale (not a network problem) – needs a person to look at it */
  error?: string;
}

const RETRY_MS = 20_000;

/**
 * Offline sales queue. When the network is down a sale is kept on this device
 * (localStorage, per user) and sent again with the same saleId until the
 * server confirms it. Because the saleId is the idempotency key, a sale that
 * actually reached the server before the connection dropped is never doubled.
 */
@Injectable({ providedIn: 'root' })
export class OutboxService {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly orders = inject(OrdersService);
  private readonly items = signal<QueuedSale[]>([]);
  private flushing = false;

  readonly pending = computed(() => this.items().filter((i) => !i.error));
  readonly failed = computed(() => this.items().filter((i) => i.error));
  readonly count = computed(() => this.items().length);
  readonly online = signal(typeof navigator === 'undefined' ? true : navigator.onLine);

  constructor() {
    effect(() => {
      const uid = this.auth.uid();
      untracked(() => {
        this.items.set(uid ? load(uid) : []);
        if (uid) void this.flush();
      });
    });
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        this.online.set(true);
        void this.flush();
      });
      window.addEventListener('offline', () => this.online.set(false));
      setInterval(() => void this.flush(), RETRY_MS);
    }
  }

  enqueue(request: ApiRequest<'recordSale'>) {
    const stamped = { ...request, businessId: this.auth.businessId() ?? undefined };
    this.update((list) => [...list.filter((i) => i.request.saleId !== request.saleId), { request: stamped, queuedAt: Date.now(), attempts: 0 }]);
  }

  /** Sends queued sales one at a time, oldest first. Stops at the first network failure. */
  async flush(): Promise<void> {
    if (this.flushing || !this.auth.uid()) return;
    this.flushing = true;
    try {
      for (const item of this.pending()) {
        try {
          const res = await this.api.call('recordSale', item.request);
          // the kitchen ticket was created offline without a receipt number
          this.orders.setReceiptNo(item.request.saleId, res.receiptNo);
          this.update((list) => list.filter((i) => i.request.saleId !== item.request.saleId));
          this.online.set(true);
        } catch (err) {
          if (err instanceof ApiError && err.network) {
            this.bump(item, undefined);
            this.online.set(false);
            return;
          }
          this.bump(item, (err as Error).message);
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  retry(saleId: string) {
    this.update((list) => list.map((i) => (i.request.saleId === saleId ? { ...i, error: undefined } : i)));
    void this.flush();
  }

  /** Drops a refused sale from this device. The owner must then record it by hand. */
  discard(saleId: string) {
    this.update((list) => list.filter((i) => i.request.saleId !== saleId));
  }

  private bump(item: QueuedSale, error: string | undefined) {
    this.update((list) => list.map((i) => (i.request.saleId === item.request.saleId ? { ...i, attempts: i.attempts + 1, error } : i)));
  }

  private update(fn: (list: QueuedSale[]) => QueuedSale[]) {
    this.items.update(fn);
    const uid = this.auth.uid();
    if (uid) save(uid, this.items());
  }
}

const key = (uid: string) => `kotahouse.outbox.${uid}`;

function load(uid: string): QueuedSale[] {
  try {
    return JSON.parse(localStorage.getItem(key(uid)) ?? '[]') as QueuedSale[];
  } catch {
    return [];
  }
}

function save(uid: string, items: QueuedSale[]) {
  try {
    localStorage.setItem(key(uid), JSON.stringify(items));
  } catch {
    // storage full or blocked – the in-memory queue still works for this session
  }
}
