import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Order } from '@shared/models';

/**
 * Hands a WhatsApp order (paid at collection) from the order queue to the
 * till. The Sell screen picks it up, loads the items and charges it; the
 * ticket is then marked paid instead of a new ticket being created.
 */
@Injectable({ providedIn: 'root' })
export class PendingChargeService {
  private readonly router = inject(Router);
  readonly ticket = signal<Order | null>(null);

  charge(order: Order) {
    this.ticket.set(order);
    void this.router.navigateByUrl('/pos');
  }

  take(): Order | null {
    const t = this.ticket();
    this.ticket.set(null);
    return t;
  }
}
