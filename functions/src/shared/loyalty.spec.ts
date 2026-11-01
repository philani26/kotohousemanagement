import { describe, expect, it } from 'vitest';
import { DEFAULT_LOYALTY, loyaltyOutcome, normalisePhone, rewardReady } from './loyalty';

const on = { ...DEFAULT_LOYALTY, enabled: true };

describe('normalisePhone', () => {
  it('accepts SA mobile numbers in the usual ways', () => {
    expect(normalisePhone('082 123 4567')).toBe('27821234567');
    expect(normalisePhone('+27 82 123 4567')).toBe('27821234567');
    expect(normalisePhone('27721234567')).toBe('27721234567');
  });
  it('rejects anything else', () => {
    expect(normalisePhone('12345')).toBeNull();
    expect(normalisePhone('011 123 4567')).toBeNull();
    expect(normalisePhone(undefined)).toBeNull();
  });
});

describe('loyaltyOutcome', () => {
  it('stamps a sale above the minimum spend', () => {
    expect(loyaltyOutcome({ stamps: 2 }, on, 3500, false)).toEqual({ rewardCents: 0, stamped: true, stampsAfter: 3 });
    expect(loyaltyOutcome({ stamps: 2 }, on, 2000, false)).toEqual({ rewardCents: 0, stamped: false, stampsAfter: 2 });
    expect(loyaltyOutcome(null, on, 3500, false).stampsAfter).toBe(1);
  });
  it('redeems a full card for up to the reward value', () => {
    expect(loyaltyOutcome({ stamps: 9 }, on, 3500, true)).toEqual({ rewardCents: 3500, stamped: false, stampsAfter: 0 });
    expect(loyaltyOutcome({ stamps: 10 }, on, 9000, true)).toEqual({ rewardCents: 4000, stamped: true, stampsAfter: 2 });
  });
  it('cannot redeem an incomplete card, and does nothing when switched off', () => {
    expect(loyaltyOutcome({ stamps: 8 }, on, 3500, true).rewardCents).toBe(0);
    expect(loyaltyOutcome({ stamps: 9 }, DEFAULT_LOYALTY, 3500, true)).toEqual({ rewardCents: 0, stamped: false, stampsAfter: 9 });
    expect(rewardReady({ stamps: 9 }, on)).toBe(true);
    expect(rewardReady({ stamps: 9 }, DEFAULT_LOYALTY)).toBe(false);
  });
});
