import { Component, computed, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { orderBy, query, where } from 'firebase/firestore';
import { DayActivity, DeviceInvite, DeviceStatus, INVITE_HOURS, ShopDevice, formatDuration } from '@shared/devices';
import { ApiService } from '../../core/api.service';
import { BusinessService } from '../../core/business.service';
import { deviceCode } from '../../core/device-id';
import { liveQuery } from '../../core/live';
import { ToastService } from '../../core/toast.service';

/** Owner: approved shop devices, the device log, and staff "Kota House not on screen" time. */
@Component({
  selector: 'app-devices',
  imports: [FormsModule, DatePipe],
  template: `
    <div class="page-head"><h1>📱 Devices</h1></div>

    <form class="card" (ngSubmit)="saveSettings()">
      <div class="card-head">
        <h2>Rules</h2>
        <span class="badge" [class.ok]="biz.settings().devices.lockToApproved">
          {{ biz.settings().devices.lockToApproved ? 'Approved devices only' : 'Any device' }}
        </span>
      </div>
      <label class="check"><input type="checkbox" name="lock" [(ngModel)]="lock" /> Staff can only work on devices I approve below</label>
      <label class="check"><input type="checkbox" name="shareLocation" [(ngModel)]="shareLocation" /> Approved shop devices used by staff share their location during trading hours</label>
      <label class="field" style="max-width: 340px; margin-top: .5rem">
        <span>Alert me when Kota House is off screen for more than (minutes a day) <span class="hint">– 0 = never</span></span>
        <input name="away" type="number" min="0" max="600" [(ngModel)]="awayMinutes" />
      </label>
      <button class="btn primary" [disabled]="busy()">Save</button>
      <p class="tiny" style="margin-top: .75rem">
        Tip: sign in once as the owner on each shop phone or tablet – it is approved automatically. This device's code is <strong>{{ myCode }}</strong>.
        Tell your staff about these checks (POPIA).
      </p>
    </form>

    <form class="card" (ngSubmit)="createInvite()">
      <h2>Add a device</h2>
      <p class="small muted">
        Give the new phone or tablet a name, then have a worker sign in on it and enter the code. It is approved straight away.
        Each code works once and expires after {{ inviteHours }} hours.
      </p>
      <div class="row" style="gap: .5rem; align-items: flex-end">
        <label class="field" style="flex: 1; min-width: 200px; margin: 0">
          <span>Device name</span>
          <input name="inviteLabel" [(ngModel)]="inviteLabel" maxlength="40" placeholder="e.g. Counter tablet" />
        </label>
        <button class="btn primary" [disabled]="busy() || inviteLabel.trim().length < 2">Get code</button>
      </div>
      @if (newInvite(); as inv) {
        <div class="device-code" style="text-align: center">
          Code for <strong style="font-size: inherit">{{ inv.label }}</strong>
          <div><strong style="font-size: 2rem; letter-spacing: .25em; margin: 0">{{ inv.code }}</strong></div>
          <div class="tiny">valid until {{ inv.expiresAtMillis | date: 'd MMM HH:mm' }}</div>
        </div>
      }
      @if (openInvites().length) {
        <div class="tiny" style="margin-top: .75rem">Codes not used yet:</div>
        @for (i of openInvites(); track i.code) {
          <div class="small">
            <strong>{{ i.code }}</strong> · {{ i.label }} <span class="muted">· until {{ i.expiresAtMillis | date: 'd MMM HH:mm' }}</span>
          </div>
        }
      }
    </form>

    <div class="card">
      <h2>Devices</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Device</th><th>Status</th><th>Last used by</th><th>Last seen</th><th>Battery</th><th></th></tr></thead>
          <tbody>
            @for (d of devices.data(); track d.id) {
              <tr [class.dim]="d.status === 'blocked'">
                <td>
                  @if (renaming() === d.id) {
                    <input [(ngModel)]="renameText" [name]="'rn' + d.id" maxlength="40" style="min-height: 34px" (keydown.enter)="rename(d)" />
                  } @else {
                    <strong>{{ d.label }}</strong>
                  }
                  <div class="tiny">code {{ d.code }}{{ d.code === myCode ? ' · this device' : '' }}</div>
                </td>
                <td><span class="badge" [class.ok]="d.status === 'approved'" [class.warn]="d.status === 'pending'" [class.bad]="d.status === 'blocked'">{{ statusText[d.status] }}</span></td>
                <td>{{ d.lastUserName ?? '–' }}</td>
                <td class="small">{{ d.lastSeenMillis ? (d.lastSeenMillis | date: 'd MMM HH:mm') : '–' }}</td>
                <td class="small">{{ d.batteryPct === null || d.batteryPct === undefined ? '–' : d.batteryPct + '%' + (d.charging ? ' ⚡' : '') }}</td>
                <td>
                  <div class="row" style="gap: .3rem; flex-wrap: nowrap">
                    @if (d.status !== 'approved') {
                      <button class="btn small primary" (click)="set(d, 'approved')">Approve</button>
                    }
                    @if (d.status !== 'blocked') {
                      <button class="btn small" (click)="set(d, 'blocked')">Block</button>
                    }
                    @if (renaming() === d.id) {
                      <button class="btn small" (click)="rename(d)">Save name</button>
                    } @else {
                      <button class="btn small ghost" (click)="startRename(d)">Rename</button>
                    }
                  </div>
                </td>
              </tr>
            } @empty {
              <tr><td colspan="6" class="empty">No devices yet – they appear here when someone signs in.</td></tr>
            }
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>Kota House off screen</h2>
        <input type="date" [ngModel]="day()" (ngModelChange)="day.set($event)" style="width: auto" />
      </div>
      <p class="small muted">
        How long Kota House was <strong>not on screen</strong> during trading hours ({{ biz.settings().openingHour }}:00–{{ biz.settings().closingHour }}:00).
        That means another app was open <strong>or</strong> the screen was off – a browser can't tell which, or see other apps. Use it as a prompt
        for a conversation, alongside sales and CCTV, not as proof.
      </p>
      @for (a of activity.data(); track a.uid) {
        <div class="away-row">
          <div class="row between">
            <div><strong>{{ a.name }}</strong> <span class="tiny">· {{ a.deviceLabel }}</span></div>
            <strong [class.away-high]="limitMs() > 0 && a.awayMs >= limitMs()">{{ duration(a.awayMs) }} off screen ({{ a.spans.length }}×)</strong>
          </div>
          <div class="away-bar" [title]="'Trading hours ' + biz.settings().openingHour + ':00–' + biz.settings().closingHour + ':00'">
            @for (s of a.spans; track s.from) {
              <span class="away-block" [style.left.%]="pos(s.from)" [style.width.%]="width(s.from, s.to)"
                [title]="(s.from | date: 'HH:mm') + '–' + (s.to | date: 'HH:mm') + ' (' + duration(s.to - s.from) + ')'"></span>
            }
          </div>
          <div class="away-scale tiny"><span>{{ biz.settings().openingHour }}:00</span><span>{{ biz.settings().closingHour }}:00</span></div>
          <details>
            <summary class="tiny">Times</summary>
            @for (s of a.spans; track s.from) {
              <div class="small">{{ s.from | date: 'HH:mm' }} – {{ s.to | date: 'HH:mm' }} · {{ duration(s.to - s.from) }}</div>
            }
          </details>
        </div>
      } @empty {
        <p class="empty">No staff activity recorded for this day</p>
      }
    </div>
  `,
})
export class DevicesPage {
  protected readonly biz = inject(BusinessService);
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  protected readonly myCode = deviceCode();
  protected readonly statusText: Record<DeviceStatus, string> = { approved: 'Approved', pending: 'Waiting for approval', blocked: 'Blocked' };
  protected readonly busy = signal(false);
  protected readonly renaming = signal<string | null>(null);
  protected renameText = '';
  protected lock = false;
  protected awayMinutes = 60;
  protected shareLocation = false;
  private loaded = false;
  protected readonly day = signal(this.biz.today());
  protected readonly limitMs = computed(() => this.biz.settings().devices.awayAlertMinutes * 60_000);

  protected readonly devices = liveQuery<ShopDevice>(() => query(this.biz.col('devices'), orderBy('lastSeenMillis', 'desc')));
  protected readonly activity = liveQuery<DayActivity>(() => query(this.biz.col('activity'), where('dayKey', '==', this.day())));

  protected readonly inviteHours = INVITE_HOURS;
  protected inviteLabel = '';
  protected readonly newInvite = signal<{ code: string; label: string; expiresAtMillis: number } | null>(null);
  private readonly invites = liveQuery<DeviceInvite>(() => query(this.biz.col('deviceInvites'), where('usedByDevice', '==', null)));
  private readonly now = signal(Date.now());
  protected readonly openInvites = computed(() =>
    this.invites
      .data()
      .filter((i) => i.expiresAtMillis > this.now())
      .sort((a, b) => b.expiresAtMillis - a.expiresAtMillis),
  );

  constructor() {
    effect(() => {
      const s = this.biz.settings();
      if (this.loaded || !s.updatedAt) return;
      this.loaded = true;
      this.lock = s.devices.lockToApproved;
      this.awayMinutes = s.devices.awayAlertMinutes;
      this.shareLocation = s.devices.shareLocation;
    });
  }

  protected duration(ms: number) {
    return formatDuration(ms);
  }

  /** position on the trading-hours bar, in % */
  protected pos(millis: number) {
    const d = new Date(millis);
    const hours = d.getHours() + d.getMinutes() / 60;
    const { openingHour: open, closingHour: close } = this.biz.settings();
    return Math.max(0, Math.min(100, ((hours - open) / Math.max(1, close - open)) * 100));
  }

  protected width(from: number, to: number) {
    return Math.max(0.6, this.pos(to) - this.pos(from));
  }

  async saveSettings() {
    this.busy.set(true);
    try {
      await this.biz.saveSettings({ devices: { lockToApproved: this.lock, awayAlertMinutes: Math.max(0, Math.min(600, Math.round(Number(this.awayMinutes) || 0))), shareLocation: this.shareLocation } });
      this.toast.ok(this.lock ? 'Staff can now only work on approved devices' : 'Saved');
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }

  async createInvite() {
    this.busy.set(true);
    try {
      const label = this.inviteLabel.trim();
      const res = await this.api.call('createDeviceInvite', { label });
      this.newInvite.set({ ...res, label });
      this.now.set(Date.now());
      this.inviteLabel = '';
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }

  async set(d: ShopDevice, status: DeviceStatus) {
    try {
      await this.api.call('setDevice', { deviceId: d.id, status });
      this.toast.ok(status === 'approved' ? `${d.label} approved` : `${d.label} blocked`);
    } catch (err) {
      this.toast.error(err);
    }
  }

  startRename(d: ShopDevice) {
    this.renaming.set(d.id);
    this.renameText = d.label;
  }

  async rename(d: ShopDevice) {
    try {
      await this.api.call('setDevice', { deviceId: d.id, label: this.renameText });
      this.renaming.set(null);
    } catch (err) {
      this.toast.error(err);
    }
  }
}
