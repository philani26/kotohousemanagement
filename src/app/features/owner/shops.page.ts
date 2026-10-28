import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { doc, getDoc } from 'firebase/firestore';
import { COLLECTIONS, Role } from '@shared/models';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FirebaseService } from '../../core/firebase.service';
import { OutboxService } from '../../core/outbox.service';
import { ToastService } from '../../core/toast.service';

interface ShopRow {
  id: string;
  name: string;
  role: Role;
}

/** Owners can run several kota houses: list them, switch between them, open a new one. */
@Component({
  selector: 'app-shops',
  imports: [FormsModule],
  template: `
    <div class="page-head"><h1>My shops</h1></div>

    <div class="grid-2">
      <div class="card">
        <h2>Your kota houses</h2>
        <p class="muted small">Each shop has its own menu, stock, cash-ups, staff and reports. Switch to work in another shop on this device.</p>
        <div class="list">
          @for (s of shops(); track s.id) {
            <div class="list-item">
              <div class="main">
                <div class="title">{{ s.name || 'Unnamed shop' }}</div>
                <div class="tiny">{{ s.role === 'owner' ? 'Owner' : 'Staff' }}</div>
              </div>
              @if (s.id === auth.businessId()) {
                <span class="badge ok">Current</span>
              } @else {
                <button class="btn small primary" (click)="switchTo(s.id)">Switch</button>
              }
            </div>
          } @empty {
            <p class="empty">Loading…</p>
          }
        </div>
      </div>

      @if (auth.ownsAShop()) {
        <form class="card" (ngSubmit)="create()">
          <h2>Open another kota house</h2>
          <p class="muted small">
            The new shop starts empty, with its own menu, ingredients, staff logins and settings. Staff of one shop cannot see another shop.
          </p>
          <label class="field"><span>Shop name</span><input name="shop" [(ngModel)]="shopName" required placeholder="e.g. Mzansi Kota House – Soweto" /></label>
          <label class="field"><span>Your name</span><input name="name" [(ngModel)]="ownerName" required /></label>
          <label class="check"><input type="checkbox" name="copy" [(ngModel)]="switchAfter" /> Switch to the new shop now</label>
          <button class="btn primary block" [disabled]="busy()">{{ busy() ? 'Creating…' : 'Create shop' }}</button>
        </form>
      }
    </div>
  `,
})
export class ShopsPage {
  protected readonly auth = inject(AuthService);
  private readonly fb = inject(FirebaseService);
  private readonly api = inject(ApiService);
  private readonly outbox = inject(OutboxService);
  private readonly toast = inject(ToastService);
  protected readonly busy = signal(false);
  private readonly names = signal<Record<string, string>>({});
  protected shopName = '';
  protected ownerName = this.auth.displayName();
  protected switchAfter = true;

  protected readonly shops = computed<ShopRow[]>(() =>
    Object.entries(this.auth.memberships())
      .map(([id, role]) => ({ id, role, name: this.names()[id] ?? '' }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

  constructor() {
    void this.loadNames();
  }

  /** Shop names come from each business document (staff of a shop may read it). */
  private async loadNames() {
    const entries = await Promise.all(
      Object.keys(this.auth.memberships()).map(async (id) => {
        try {
          const snap = await getDoc(doc(this.fb.db, COLLECTIONS.businesses, id));
          return [id, (snap.get('name') as string) ?? ''] as const;
        } catch {
          return [id, ''] as const;
        }
      }),
    );
    this.names.set(Object.fromEntries(entries));
  }

  switchTo(id: string) {
    if (this.outbox.count()) {
      this.toast.error('Sales saved offline are still on this phone. Wait for them to send before switching shops.');
      return;
    }
    this.auth.switchShop(id, '/dashboard');
  }

  async create() {
    if (this.shopName.trim().length < 2) return this.toast.error('Enter the shop name');
    this.busy.set(true);
    try {
      const { businessId } = await this.api.call('setupBusiness', { businessName: this.shopName, displayName: this.ownerName });
      await this.auth.refreshClaims();
      this.toast.ok(`${this.shopName} created`);
      if (this.switchAfter) {
        this.auth.switchShop(businessId, '/products');
      } else {
        this.shopName = '';
        await this.loadNames();
      }
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}
