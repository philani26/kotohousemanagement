/**
 * Shop devices and "away from the app" time: pure logic shared by the
 * server and the app.
 *
 * A browser cannot see other apps, so "away" means Kota House was not on
 * screen: the worker switched to another app OR the screen was off. Only
 * time inside trading hours counts.
 */

export type DeviceStatus = 'pending' | 'approved' | 'blocked';

/** businesses/{b}/devices/{deviceId} – written by functions only. */
export interface ShopDevice {
  id: string;
  label: string;
  /** short code shown on the device so the owner can recognise it */
  code: string;
  userAgent: string;
  status: DeviceStatus;
  lastUid?: string;
  lastUserName?: string;
  lastSeenMillis?: number;
  /** 0–100, when the browser shares it */
  batteryPct?: number | null;
  charging?: boolean | null;
  firstSeenMillis: number;
  /** last reported position (only when the owner switched location sharing on) */
  lastLocation?: DeviceLocation | null;
  /** today's positions, most recent last (capped) */
  trail?: DeviceLocation[];
}

export interface DeviceLocation {
  lat: number;
  lng: number;
  accuracyM: number;
  atMillis: number;
  /** metres from the shop, when the shop location is set */
  distanceM?: number | null;
}

/** businesses/{b}/deviceInvites/{code} – a pairing code the owner gives to a new device. */
export interface DeviceInvite {
  code: string;
  label: string;
  createdBy: string;
  expiresAtMillis: number;
  usedByDevice?: string | null;
}

export const MAX_TRAIL = 40;
export const INVITE_HOURS = 24;

export interface DeviceSettings {
  /** staff may only work on devices the owner approved */
  lockToApproved: boolean;
  /** alert the owner when a worker's away time in a day passes this (0 = never) */
  awayAlertMinutes: number;
  /** approved shop devices used by staff report where they are while Kota House is open, during trading hours */
  shareLocation: boolean;
}

export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = { lockToApproved: false, awayAlertMinutes: 60, shareLocation: false };

export interface Span {
  from: number;
  to: number;
}

/** businesses/{b}/activity/{uid}_{dayKey} – away time per worker per day. */
export interface DayActivity {
  uid: string;
  name: string;
  dayKey: string;
  awayMs: number;
  /** most recent away spans (capped) for the timeline */
  spans: Span[];
  deviceId?: string;
  deviceLabel?: string;
  lastSeenMillis?: number;
}

export const MAX_SPANS_KEPT = 60;
/** ignore glances shorter than this (notifications, quick unlocks) */
export const MIN_SPAN_MS = 30_000;

/** Keeps only the part of a span inside [start, end); returns null if nothing is left. */
export function clipSpan(span: Span, start: number, end: number): Span | null {
  if (!(span.to > span.from)) return null;
  const from = Math.max(span.from, start);
  const to = Math.min(span.to, end);
  return to - from >= MIN_SPAN_MS ? { from, to } : null;
}

export function totalMs(spans: Span[]): number {
  return spans.reduce((s, x) => s + (x.to - x.from), 0);
}

/** "Samsung SM-A146B · Chrome", "iPhone · Safari", "Windows PC · Edge" from a user-agent string. */
export function deviceLabel(ua: string): string {
  const browser = /EdgA?\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const android = /Android[^;]*;\s*([^;)]+?)(?:\s+Build|\))/.exec(ua);
  if (android) {
    const model = android[1].trim();
    const brand = /^SM-|^GT-/.test(model) ? 'Samsung ' : '';
    return `${model === 'K' ? 'Android phone' : brand + model} · ${browser}`;
  }
  if (/iPhone/.test(ua)) return `iPhone · ${browser}`;
  if (/iPad|Macintosh.*Mobile/.test(ua)) return `iPad · ${browser}`;
  if (/Windows/.test(ua)) return `Windows PC · ${browser}`;
  if (/Macintosh/.test(ua)) return `Mac · ${browser}`;
  return `Device · ${browser}`;
}

/** "1 h 40 min" / "12 min" */
export function formatDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
}
