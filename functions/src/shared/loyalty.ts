/**
 * Customers and a simple stamp card, shared by the server and the app.
 * A sale of at least `minSpendCents` earns one stamp. With `stampsNeeded`
 * stamps the customer gets a reward: up to `rewardValueCents` off a sale
 * (e.g. "buy 9 kotas, the 10th is free").
 */
import { Cents } from './money';

export interface LoyaltySettings {
  enabled: boolean;
  stampsNeeded: number;
  minSpendCents: Cents;
  rewardValueCents: Cents;
}

export const DEFAULT_LOYALTY: LoyaltySettings = { enabled: false, stampsNeeded: 9, minSpendCents: 3000, rewardValueCents: 4000 };

/** businesses/{b}/customers/{phone} – phone is 27XXXXXXXXX. Written by functions only. */
export interface Customer {
  phone: string;
  name: string;
  visits: number;
  spentCents: Cents;
  stamps: number;
  rewardsRedeemed: number;
  firstVisitMillis: number;
  lastVisitMillis: number;
}

/** 082 123 4567 / +27 82 123 4567 / 27821234567 → 27821234567; null if it is not a SA mobile number. */
export function normalisePhone(input: unknown): string | null {
  let d = String(input ?? '').replace(/\D/g, '');
  if (/^0\d{9}$/.test(d)) d = `27${d.slice(1)}`;
  return /^27[6-8]\d{8}$/.test(d) ? d : null;
}

export function rewardReady(c: Pick<Customer, 'stamps'> | null | undefined, s: LoyaltySettings): boolean {
  return !!c && s.enabled && c.stamps >= s.stampsNeeded;
}

export interface LoyaltyOutcome {
  /** taken off the sale */
  rewardCents: Cents;
  /** stamp earned by this sale */
  stamped: boolean;
  stampsAfter: number;
}

/**
 * What a sale does to the customer's card. `totalCents` is the total before
 * the reward. Redeeming uses up `stampsNeeded` stamps; the sale can still earn
 * a stamp on what the customer actually pays.
 */
export function loyaltyOutcome(c: Pick<Customer, 'stamps'> | null, s: LoyaltySettings, totalCents: Cents, redeem: boolean): LoyaltyOutcome {
  const stamps = c?.stamps ?? 0;
  if (!s.enabled) return { rewardCents: 0, stamped: false, stampsAfter: stamps };
  const redeeming = redeem && stamps >= s.stampsNeeded;
  const rewardCents = redeeming ? Math.min(s.rewardValueCents, totalCents) : 0;
  const stamped = totalCents - rewardCents >= s.minSpendCents;
  return { rewardCents, stamped, stampsAfter: stamps - (redeeming ? s.stampsNeeded : 0) + (stamped ? 1 : 0) };
}

/** The owner writes these settings directly, so keep them within sane limits. */
export function cleanLoyalty(s: Partial<LoyaltySettings> | undefined): LoyaltySettings {
  const int = (v: unknown, min: number, max: number, fallback: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  };
  return {
    enabled: s?.enabled === true,
    stampsNeeded: int(s?.stampsNeeded, 1, 50, DEFAULT_LOYALTY.stampsNeeded),
    minSpendCents: int(s?.minSpendCents, 0, 1_000_000, DEFAULT_LOYALTY.minSpendCents),
    rewardValueCents: int(s?.rewardValueCents, 0, 100_000, DEFAULT_LOYALTY.rewardValueCents),
  };
}
