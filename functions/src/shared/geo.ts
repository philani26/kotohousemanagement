/**
 * Work-site check (geofence): pure maths shared by the server and the app.
 * Only the distance from the shop is ever stored, never where the person was.
 */

export interface GeoPoint {
  lat: number;
  lng: number;
}

/** Owner settings: where the shop is and how far away staff may still sign in. */
export interface GeofenceSettings {
  enabled: boolean;
  lat: number | null;
  lng: number | null;
  /** metres */
  radiusM: number;
}

export const DEFAULT_GEOFENCE: GeofenceSettings = { enabled: false, lat: null, lng: null, radiusM: 150 };
/** a successful check-in lasts this long */
export const SITE_CHECK_HOURS = 12;
/** readings less precise than this are refused – usually GPS is off */
export const MAX_ACCURACY_M = 300;

export function isValidPoint(p: Partial<GeoPoint> | null | undefined): p is GeoPoint {
  return !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat!) <= 90 && Math.abs(p.lng!) <= 180;
}

/** Great-circle distance in metres (haversine). */
export function distanceM(a: GeoPoint, b: GeoPoint): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

export type SiteDecision =
  | { ok: true; distanceM: number }
  | { ok: false; reason: 'inaccurate' | 'outside' | 'not-configured'; distanceM?: number };

/**
 * Decides a check-in. A small part of the phone's reported accuracy (up to
 * 50 m) is allowed on top of the radius, so a person standing in the shop
 * with a slightly fuzzy GPS fix is not locked out.
 */
export function decideSiteCheck(fence: GeofenceSettings, at: GeoPoint, accuracyM: number): SiteDecision {
  if (!fence.enabled) return { ok: true, distanceM: 0 };
  if (!isValidPoint({ lat: fence.lat ?? NaN, lng: fence.lng ?? NaN })) return { ok: false, reason: 'not-configured' };
  if (!Number.isFinite(accuracyM) || accuracyM > MAX_ACCURACY_M) return { ok: false, reason: 'inaccurate' };
  const d = distanceM({ lat: fence.lat!, lng: fence.lng! }, at);
  return d <= fence.radiusM + Math.min(Math.max(accuracyM, 0), 50) ? { ok: true, distanceM: d } : { ok: false, reason: 'outside', distanceM: d };
}

/** "850 m" / "3.2 km" */
export function formatDistance(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}
