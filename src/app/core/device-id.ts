/**
 * A random id that identifies this browser on this phone/tablet, kept in
 * localStorage. Browsers cannot read hardware ids; clearing the browser's data
 * creates a "new device" that the owner has to approve again.
 */
const KEY = 'kotahouse.deviceId';

let cached: string | null = null;

export function deviceId(): string {
  if (cached) return cached;
  try {
    cached = localStorage.getItem(KEY);
    if (!cached) {
      cached = crypto.randomUUID();
      localStorage.setItem(KEY, cached);
    }
  } catch {
    cached = cached ?? crypto.randomUUID(); // storage blocked: works for this session only
  }
  return cached;
}

/** short code shown on the device and on the owner's Devices page */
export function deviceCode(): string {
  return deviceId().replace(/-/g, '').slice(0, 4).toUpperCase();
}
