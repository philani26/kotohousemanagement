import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { formatDistance } from '@shared/geo';
import { AuthService } from '../core/auth.service';
import { BusinessService } from '../core/business.service';
import { SiteCheckService } from '../core/site-check.service';

/** Shown to cashiers and kitchen staff until they have checked in at the shop. */
@Component({
  selector: 'app-site-check',
  template: `
    <div class="site-check card">
      <div class="site-ico">📍</div>
      <h1>Check in at {{ biz.settings().businessName }}</h1>
      <p class="muted">You can only use the till and the order board while you are at the shop.</p>

      <div class="site-disclosure small">
        <strong>What happens:</strong> your phone shares its location <strong>once</strong>, now. We only work out how far you are from the
        shop. Your location is not stored or tracked – only the distance and the time of this check-in are saved.
      </div>

      @if (result(); as r) {
        <div class="alert" [class.bad]="!r.ok" [class.ok]="r.ok">{{ r.text }}</div>
      }

      <button class="btn charge-btn block" [disabled]="busy()" (click)="check()">
        {{ busy() ? 'Finding your location…' : 'Allow location and check in' }}
      </button>
      <button class="btn ghost block" style="margin-top: .5rem" (click)="signOut()">Sign out</button>
    </div>
  `,
})
export class SiteCheckComponent {
  protected readonly auth = inject(AuthService);
  protected readonly biz = inject(BusinessService);
  private readonly site = inject(SiteCheckService);
  private readonly router = inject(Router);
  protected readonly busy = signal(false);
  protected readonly result = signal<{ ok: boolean; text: string } | null>(null);

  async signOut() {
    await this.auth.signOut();
    await this.router.navigateByUrl('/login');
  }

  async check() {
    this.busy.set(true);
    this.result.set(null);
    try {
      const r = await this.site.checkIn();
      if (r.ok) {
        this.result.set({ ok: true, text: `Checked in ✓ (${formatDistance(r.distanceM ?? 0)} from the shop)` });
      } else if (r.reason === 'outside') {
        this.result.set({ ok: false, text: `You are ${formatDistance(r.distanceM ?? 0)} from the shop. You can only sign in at work. The owner has been notified.` });
      } else if (r.reason === 'inaccurate') {
        this.result.set({ ok: false, text: 'Your location is too vague. Turn on GPS / high-accuracy location, go near a window, and try again.' });
      } else {
        this.result.set({ ok: false, text: 'The shop location has not been set yet. Ask the owner to set it in Settings › Work site.' });
      }
    } catch (err) {
      this.result.set({ ok: false, text: (err as Error).message });
    } finally {
      this.busy.set(false);
    }
  }
}
