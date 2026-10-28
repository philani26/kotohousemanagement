import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';

/** First run: a signed-in user without a business creates one and becomes its owner. */
@Component({
  selector: 'app-setup',
  imports: [FormsModule],
  template: `
    <div class="auth-wrap">
      <div class="card auth-card">
        <div class="logo">Kota<span>House</span></div>
        @if (!auth.user()) {
          <p>Please sign in first.</p>
          <button class="btn primary block" (click)="router.navigateByUrl('/login')">Go to sign in</button>
        } @else if (auth.businessId()) {
          <p>Your account is already linked to a shop.</p>
          <button class="btn primary block" (click)="router.navigateByUrl('/')">Continue</button>
        } @else {
          <h2>Set up your shop</h2>
          <p class="muted">
            You will be the <strong>owner</strong>. You can add your cashier, menu and ingredients next.
            If you are a cashier, ask the owner to create your login instead.
          </p>
          <form (ngSubmit)="create()">
            <label class="field"><span>Shop name</span><input name="shop" [(ngModel)]="shop" required placeholder="e.g. Mzansi Kota House" /></label>
            <label class="field"><span>Your name</span><input name="name" [(ngModel)]="name" required /></label>
            <button class="btn primary block xl" [disabled]="busy()">{{ busy() ? 'Creating…' : 'Create shop' }}</button>
          </form>
          <button class="btn ghost small" style="margin-top: 1rem" (click)="signOut()">Sign out</button>
        }
      </div>
    </div>
  `,
})
export class SetupPage {
  protected readonly auth = inject(AuthService);
  protected readonly router = inject(Router);
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  protected readonly busy = signal(false);
  protected shop = '';
  protected name = this.auth.user()?.displayName ?? '';

  async create() {
    this.busy.set(true);
    try {
      await this.api.call('setupBusiness', { businessName: this.shop, displayName: this.name });
      await this.auth.refreshClaims();
      this.toast.ok('Shop created');
      await this.router.navigateByUrl('/products');
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }

  async signOut() {
    await this.auth.signOut();
    await this.router.navigateByUrl('/login');
  }
}
