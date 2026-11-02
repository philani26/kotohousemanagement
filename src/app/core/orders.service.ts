import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { ApiName, ApiRequest } from '@shared/api';
import { Order, OrderStatus } from '@shared/models';
import { ApiError, ApiService } from './api.service';
import { AuthService } from './auth.service';
import { BusinessService } from './business.service';

type TicketCall =
  | { name: 'createOrder'; data: ApiRequest<'createOrder'> & { businessId?: string } }
  | { name: 'setOrderStatus'; data: ApiRequest<'setOrderStatus'> & { businessId?: string } }
  | { name: 'linkOrderSale'; data: ApiRequest<'linkOrderSale'> & { businessId?: string } };

const RETRY_MS = 15_000;
const key = (uid: string) => `kotahouse.ticketQueue.${uid}`;

/**
 * Kitchen tickets. Changes are sent to the server in order; while the
 * network is down they wait on this phone and still show on the queue
 * straight away (see apply), so the queue works through load-shedding.
 * Every call is safe to repeat (the ticket id is the sale id).
 */
@Injectable({ providedIn: 'root' })
export class OrdersService {
  private readonly biz = inject(BusinessService);
  private readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);
  /** ticket changes not yet confirmed by the server, oldest first */
  readonly queued = signal<TicketCall[]>([]);
  private sending = false;

  constructor() {
    effect(() => {
      const uid = this.auth.uid();
      untracked(() => {
        this.queued.set(uid ? load(uid) : []);
        if (uid) void this.flush();
      });
    });
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => void this.flush());
      setInterval(() => void this.flush(), RETRY_MS);
    }
  }

  /** Creates the ticket for a sale. Uses the saleId, so a retried sale never makes a second ticket. */
  create(saleId: string, lines: { name: string; quantity: number }[], note: string, receiptNo: number | null) {
    this.send({ name: 'createOrder', data: { orderId: saleId, lines, ...(note.trim() ? { note: note.trim().slice(0, 200) } : {}), receiptNo, createdAtMillis: Date.now() } });
  }

  /** Adds the receipt number once an offline sale has reached the server. */
  setReceiptNo(saleId: string, receiptNo: number) {
    this.send({ name: 'linkOrderSale', data: { orderId: saleId, receiptNo } });
  }

  /** A WhatsApp order was charged at the till: link the sale and mark it paid. */
  markPaid(orderId: string, saleId: string, receiptNo: number | null) {
    this.send({ name: 'linkOrderSale', data: { orderId, saleId, paid: true, ...(receiptNo ? { receiptNo } : {}) } });
  }

  setStatus(order: Order, status: OrderStatus) {
    this.send({ name: 'setOrderStatus', data: { orderId: order.id, status, atMillis: Date.now() } });
  }

  /** The server's list with this phone's unsent changes on top, so the queue reacts immediately. */
  apply(orders: Order[]): Order[] {
    const queued = this.queued();
    if (!queued.length) return orders;
    const byId = new Map(orders.map((o) => [o.id, { ...o }]));
    const uid = this.auth.uid();
    for (const call of queued) {
      const d = call.data;
      const o = byId.get(d.orderId);
      if (call.name === 'createOrder' && !o) {
        byId.set(d.orderId, {
          id: d.orderId,
          receiptNo: call.data.receiptNo,
          lines: call.data.lines,
          ...(call.data.note ? { note: call.data.note } : {}),
          status: 'new',
          createdAtMillis: call.data.createdAtMillis,
          createdBy: uid,
          createdByName: this.auth.displayName(),
          dayKey: this.biz.today(),
          updatedBy: uid,
          updatedAt: null as unknown as Order['updatedAt'],
        });
      } else if (call.name === 'setOrderStatus' && o) {
        o.status = call.data.status;
      } else if (call.name === 'linkOrderSale' && o) {
        if (call.data.receiptNo) o.receiptNo = call.data.receiptNo;
        if (call.data.paid) o.paid = true;
      }
    }
    return [...byId.values()].sort((a, b) => a.createdAtMillis - b.createdAtMillis);
  }

  private send(call: TicketCall) {
    call.data.businessId = this.auth.businessId() ?? undefined;
    this.update((list) => [...list, call]);
    void this.flush();
  }

  /** Sends queued changes one at a time, oldest first; stops at the first network failure. */
  private async flush() {
    if (this.sending || !this.auth.uid()) return;
    this.sending = true;
    try {
      for (const call of [...this.queued()]) {
        try {
          await this.api.call(call.name as ApiName, call.data as never);
        } catch (err) {
          if (err instanceof ApiError && err.network) return;
          // refused by the server (e.g. ticket of only extras): drop it, it can never succeed
          console.error('Order ticket change refused', call, err);
        }
        this.update((list) => list.filter((c) => c !== call && JSON.stringify(c) !== JSON.stringify(call)));
      }
    } finally {
      this.sending = false;
    }
  }

  private update(fn: (list: TicketCall[]) => TicketCall[]) {
    this.queued.update(fn);
    const uid = this.auth.uid();
    if (uid) {
      try {
        localStorage.setItem(key(uid), JSON.stringify(this.queued()));
      } catch {
        // storage blocked: changes still go out while this page is open
      }
    }
  }
}

function load(uid: string): TicketCall[] {
  try {
    return JSON.parse(localStorage.getItem(key(uid)) ?? '[]') as TicketCall[];
  } catch {
    return [];
  }
}
