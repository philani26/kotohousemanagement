import { Component, DestroyRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../core/auth.service';
import { DeviceService } from '../core/device.service';
import { ToastService } from '../core/toast.service';

/** Shown to staff on a phone/tablet the owner has not approved (yet). */
@Component({
  selector: 'app-device-blocked',
  imports: [FormsModule],
  template: `
    <div class="site-check card">
      <div class="site-ico">📱</div>
      @if (device.status() === 'blocked') {
        <h1>This device is blocked</h1>
        <p class="muted">The owner has blocked this phone for Kota House. Use the shop's device instead.</p>
      } @else {
        <h1>Waiting for the owner to approve this device</h1>
        <p class="muted">Staff can only work on the shop's approved phones and tablets. Ask the owner to approve this one under <strong>Devices</strong>, or enter the code they give you.</p>
        <form class="row" style="gap: .5rem; flex-wrap: nowrap; margin-top: 1rem" (ngSubmit)="pair()">
          <input name="code" [(ngModel)]="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="6-digit code"
            style="text-align: center; font-size: 1.2rem; letter-spacing: .2em" />
          <button class="btn primary" [disabled]="pairing() || digits().length !== 6">{{ pairing() ? 'Adding…' : 'Add device' }}</button>
        </form>
      }
      <div class="device-code">Device code <strong>{{ device.code }}</strong></div>
      <button class="btn charge-btn block" (click)="device.beat()">Check again</button>
      <button class="btn ghost block" style="margin-top: .5rem" (click)="signOut()">Sign out</button>
    </div>
  `,
})
export class DeviceBlockedComponent {
  protected readonly device = inject(DeviceService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  protected code = '';
  protected readonly pairing = signal(false);

  constructor() {
    // keep checking while waiting, so the screen clears as soon as the owner approves
    const timer = setInterval(() => void this.device.beat(), 15_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected digits() {
    return this.code.replace(/\D/g, '');
  }

  async pair() {
    this.pairing.set(true);
    try {
      const label = await this.device.pair(this.digits());
      this.toast.ok(`This device is now "${label}"`);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.pairing.set(false);
    }
  }

  async signOut() {
    await this.auth.signOut();
    await this.router.navigateByUrl('/login');
  }
}
