import { describe, expect, it } from 'vitest';
import { clipSpan, deviceLabel, formatDuration, totalMs } from './devices';

const H = 3_600_000;

describe('away spans', () => {
  const open = 9 * H;
  const close = 20 * H;

  it('keeps spans inside trading hours', () => {
    expect(clipSpan({ from: 10 * H, to: 11 * H }, open, close)).toEqual({ from: 10 * H, to: 11 * H });
  });

  it('cuts off the part outside trading hours (e.g. phone locked overnight)', () => {
    expect(clipSpan({ from: 19 * H, to: 33 * H }, open, close)).toEqual({ from: 19 * H, to: 20 * H });
    expect(clipSpan({ from: 2 * H, to: 4 * H }, open, close)).toBeNull();
  });

  it('ignores quick glances and broken spans', () => {
    expect(clipSpan({ from: 10 * H, to: 10 * H + 20_000 }, open, close)).toBeNull();
    expect(clipSpan({ from: 11 * H, to: 10 * H }, open, close)).toBeNull();
  });

  it('adds up and formats', () => {
    expect(totalMs([{ from: 0, to: H }, { from: 2 * H, to: 2 * H + 40 * 60_000 }])).toBe(H + 40 * 60_000);
    expect(formatDuration(H + 40 * 60_000)).toBe('1 h 40 min');
    expect(formatDuration(12 * 60_000)).toBe('12 min');
  });
});

describe('deviceLabel', () => {
  it('names common phones and browsers', () => {
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 14; SM-A146B Build/UP1A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36')).toBe(
      'Samsung SM-A146B · Chrome',
    );
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1')).toBe(
      'iPhone · Safari',
    );
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0')).toBe(
      'Windows PC · Edge',
    );
  });
});
