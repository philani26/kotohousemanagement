import { describe, expect, it } from 'vitest';
import { DEFAULT_GEOFENCE, decideSiteCheck, distanceM, formatDistance } from './geo';

// A shop in Soweto and points around it
const shop = { lat: -26.2485, lng: 27.854 };
const fence = { ...DEFAULT_GEOFENCE, enabled: true, lat: shop.lat, lng: shop.lng, radiusM: 150 };

describe('distanceM', () => {
  it('measures short and long distances', () => {
    expect(distanceM(shop, shop)).toBe(0);
    expect(distanceM(shop, { lat: shop.lat + 0.001, lng: shop.lng })).toBeGreaterThan(100); // ~111 m
    expect(distanceM(shop, { lat: shop.lat + 0.001, lng: shop.lng })).toBeLessThan(120);
    const sandton = { lat: -26.1076, lng: 28.0567 };
    expect(distanceM(shop, sandton) / 1000).toBeGreaterThan(24);
    expect(distanceM(shop, sandton) / 1000).toBeLessThan(27);
  });
});

describe('decideSiteCheck', () => {
  it('lets everyone in when the geofence is off', () => {
    expect(decideSiteCheck(DEFAULT_GEOFENCE, { lat: 0, lng: 0 }, 9999).ok).toBe(true);
  });

  it('allows a worker inside the radius', () => {
    expect(decideSiteCheck(fence, { lat: shop.lat + 0.0005, lng: shop.lng }, 20)).toEqual({ ok: true, distanceM: 56 });
  });

  it('allows a little GPS fuzz at the edge, but not far away', () => {
    const edge = { lat: shop.lat + 0.0016, lng: shop.lng }; // ~178 m
    expect(decideSiteCheck(fence, edge, 40).ok).toBe(true);
    expect(decideSiteCheck(fence, edge, 5).ok).toBe(false);
    const far = decideSiteCheck(fence, { lat: -26.1076, lng: 28.0567 }, 10);
    expect(far.ok).toBe(false);
    expect(!far.ok && far.reason).toBe('outside');
  });

  it('refuses vague readings and a fence without a location', () => {
    expect(decideSiteCheck(fence, shop, 2000)).toEqual({ ok: false, reason: 'inaccurate' });
    expect(decideSiteCheck({ ...fence, lat: null }, shop, 10)).toEqual({ ok: false, reason: 'not-configured' });
  });

  it('formats distances for people', () => {
    expect(formatDistance(850)).toBe('850 m');
    expect(formatDistance(3240)).toBe('3.2 km');
  });
});
