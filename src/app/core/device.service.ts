import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { DeviceStatus, Span } from '@shared/devices';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { BusinessService } from './business.service';
import { deviceCode, deviceId } from './device-id';

const HEARTBEAT_MS = 2 * 60_000;
const PENDING_KEY = 'kotahouse.awaySpans';

interface BatteryManagerLike {
  level: number;
  charging: boolean;
}

/**
 * Registers this phone/tablet with the shop, keeps the owner's device log up
 * to date, and measures how long Kota House was not on screen (another app
 * open, or the screen off) for cashiers and kitchen staff. Nothing about other
 * apps is visible to a web app – only whether Kota House itself is showing.
 */
@Injectable({ providedIn: 'root' })
export class DeviceService {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly biz = inject(BusinessService);

  readonly id = deviceId();
  readonly code = deviceCode();
  readonly status = signal<DeviceStatus | null>(null);
  private hiddenAt: number | null = null;
  private sending = false;

  /** staff must use an approved device when the owner switched the lock on */
  readonly blocked = computed(() => {
    if (this.auth.isOwner() || !this.biz.settings().devices.lockToApproved) return false;
    return this.status() !== 'approved';
  });

  constructor() {
    // (re)register whenever someone signs in to a shop
    effect(() => {
      const signedIn = !!this.auth.uid() && !!this.auth.businessId();
      if (signedIn) untracked(() => void this.beat());
      else untracked(() => this.status.set(null));
    });

    if (typeof document !== 'undefined') {
      const onVisibility = () => {
        if (document.visibilityState === 'hidden') {
          this.hiddenAt = Date.now();
        } else if (this.hiddenAt) {
          if (this.isStaff()) this.queueSpan({ from: this.hiddenAt, to: Date.now() });
          this.hiddenAt = null;
          void this.beat();
        }
      };
      document.addEventListener('visibilitychange', onVisibility);
      // phones often kill the page instead of sending "visible" again: remember the start
      window.addEventListener('pagehide', () => this.hiddenAt ?? (this.hiddenAt = Date.now()));
      const timer = setInterval(() => document.visibilityState === 'visible' && void this.beat(), HEARTBEAT_MS);
      inject(DestroyRef).onDestroy(() => {
        clearInterval(timer);
        document.removeEventListener('visibilitychange', onVisibility);
      });
    }
  }

  private isStaff() {
    return !!this.auth.businessId() && !this.auth.isOwner();
  }

  /** Away spans are kept on the phone until the server confirms them. */
  private queueSpan(span: Span) {
    const list = readSpans();
    list.push(span);
    writeSpans(list.slice(-50));
  }

  /** Pairs this device with the owner's one-time code; it is approved straight away. Returns the device name. */
  async pair(code: string): Promise<string> {
    const res = await this.api.call('pairDevice', { code, deviceId: this.id, userAgent: navigator.userAgent });
    this.status.set(res.status);
    return res.label;
  }

  /** Sends the heartbeat now (also used by the "check again" button). */
  async beat(): Promise<void> {
    if (this.sending || !this.auth.uid() || !this.auth.businessId()) return;
    this.sending = true;
    try {
      const spans = this.isStaff() ? readSpans() : [];
      const battery = await readBattery();
      const res = await this.api.call('deviceHeartbeat', {
        deviceId: this.id,
        userAgent: navigator.userAgent,
        batteryPct: battery ? Math.round(battery.level * 100) : null,
        charging: battery ? battery.charging : null,
        spans,
      });
      this.status.set(res.status);
      if (spans.length) writeSpans(readSpans().filter((s) => !spans.some((x) => x.from === s.from)));
    } catch {
      // offline or not allowed yet: try again at the next heartbeat; spans stay queued
    } finally {
      this.sending = false;
    }
  }
}

async function readBattery(): Promise<BatteryManagerLike | null> {
  try {
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManagerLike> };
    return nav.getBattery ? await nav.getBattery() : null;
  } catch {
    return null;
  }
}

function readSpans(): Span[] {
  try {
    return JSON.parse(localStorage.getItem(PENDING_KEY) ?? '[]') as Span[];
  } catch {
    return [];
  }
}

function writeSpans(spans: Span[]) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(spans));
  } catch {
    // storage blocked: spans are lost for this session
  }
}
