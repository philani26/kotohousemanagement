import { Injectable, inject } from '@angular/core';
import { serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { Order, OrderStatus } from '@shared/models';
import { AuthService } from './auth.service';
import { BusinessService } from './business.service';

const STAMP_FIELD: Partial<Record<OrderStatus, 'preparingAt' | 'readyAt' | 'collectedAt'>> = {
  preparing: 'preparingAt',
  ready: 'readyAt',
  collected: 'collectedAt',
};

/**
 * Kitchen tickets. Writes are not awaited: Firestore applies them to the local
 * cache immediately and syncs when online, so the queue works through
 * load-shedding exactly like it does with signal.
 */
@Injectable({ providedIn: 'root' })
export class OrdersService {
  private readonly biz = inject(BusinessService);
  private readonly auth = inject(AuthService);

  /** Creates the ticket for a sale. Uses the saleId, so a retried sale never makes a second ticket. */
  create(saleId: string, lines: { name: string; quantity: number }[], note: string, receiptNo: number | null) {
    const uid = this.auth.uid();
    const order: Omit<Order, 'updatedAt'> = {
      id: saleId,
      receiptNo,
      lines,
      ...(note.trim() ? { note: note.trim().slice(0, 200) } : {}),
      status: 'new',
      createdAtMillis: Date.now(),
      createdBy: uid,
      createdByName: this.auth.displayName(),
      dayKey: this.biz.today(),
      updatedBy: uid,
    };
    return this.write(setDoc(this.biz.docRef('orders', saleId), { ...order, updatedAt: serverTimestamp() }));
  }

  /** Adds the receipt number once an offline sale has reached the server. */
  setReceiptNo(saleId: string, receiptNo: number) {
    return this.write(updateDoc(this.biz.docRef('orders', saleId), { receiptNo, updatedBy: this.auth.uid(), updatedAt: serverTimestamp() }));
  }

  setStatus(order: Order, status: OrderStatus) {
    const field = STAMP_FIELD[status];
    return this.write(
      updateDoc(this.biz.docRef('orders', order.id), {
        status,
        ...(field ? { [field]: Date.now() } : {}),
        updatedBy: this.auth.uid(),
        updatedAt: serverTimestamp(),
      }),
    );
  }

  private write(p: Promise<void>) {
    // Resolves only when the server acknowledges; the local cache is already updated.
    p.catch((err) => {
      // Sales of only extras have no ticket, so a receipt-number update may find nothing.
      if ((err as { code?: string }).code !== 'not-found') console.error('Order ticket write failed', err);
    });
  }
}
