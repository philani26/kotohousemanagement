import { describe, expect, it } from 'vitest';
import {
  DomainError,
  dayKey,
  dayRange,
  emptyDailyStats,
  expectedCash,
  ingredientUsage,
  isLowStock,
  localHour,
  priceCart,
  clampStockChange,
  inOrderQueue,
  reorderQty,
  resolveSoldAt,
  waPhone,
  profitSummary,
  reconcileCash,
  settlePayment,
  stockCountLine,
  sumStats,
} from './domain';
import { formatZar, parseRandToCents } from './money';
import { Ingredient, Product, Recipe } from './models';

const product = (id: string, priceCents: number, active = true): Product => ({
  id,
  name: id,
  category: 'kota',
  priceCents,
  active,
  sortOrder: 0,
});
const products = new Map([
  ['basic', product('basic', 3500)],
  ['russian', product('russian', 5500)],
  ['old', product('old', 1000, false)],
]);

const ingredient = (id: string, unitCostCents: number, currentQty = 100): Ingredient => ({
  id,
  name: id,
  unit: 'each',
  openingQty: currentQty,
  currentQty,
  unitCostCents,
  reorderLevel: 10,
  active: true,
});
const ingredients = new Map([
  ['bread', ingredient('bread', 450)],
  ['chips', { ...ingredient('chips', 2000), unit: 'kg' as const }],
  ['russian', ingredient('russian', 900)],
]);
const recipes = new Map<string, Recipe>([
  ['basic', { productId: 'basic', lines: [{ ingredientId: 'bread', quantity: 0.25 }, { ingredientId: 'chips', quantity: 0.15 }] }],
  ['russian', { productId: 'russian', lines: [{ ingredientId: 'bread', quantity: 0.25 }, { ingredientId: 'chips', quantity: 0.15 }, { ingredientId: 'russian', quantity: 1 }] }],
]);

describe('money', () => {
  it('parses rand input into integer cents', () => {
    expect(parseRandToCents('45')).toBe(4500);
    expect(parseRandToCents('45.5')).toBe(4550);
    expect(parseRandToCents('R 45,05')).toBe(4505);
    expect(parseRandToCents('0.1')).toBe(10);
    expect(parseRandToCents('-5')).toBeNull();
    expect(parseRandToCents('12.345')).toBeNull();
    expect(parseRandToCents('abc')).toBeNull();
  });

  it('formats cents as South African rand', () => {
    expect(formatZar(123456)).toMatch(/R\s?1\s?234,56/);
  });
});

describe('priceCart (sales)', () => {
  it('prices from the product list, not the client', () => {
    const sale = priceCart([{ productId: 'basic', quantity: 2 }, { productId: 'russian', quantity: 1 }], products);
    expect(sale.subtotalCents).toBe(3500 * 2 + 5500);
    expect(sale.totalCents).toBe(12500);
    expect(sale.lines.find((l) => l.productId === 'basic')?.lineTotalCents).toBe(7000);
  });

  it('merges duplicate lines', () => {
    const sale = priceCart([{ productId: 'basic', quantity: 1 }, { productId: 'basic', quantity: 2 }], products);
    expect(sale.lines).toHaveLength(1);
    expect(sale.lines[0].quantity).toBe(3);
  });

  it('applies a discount but never below zero', () => {
    expect(priceCart([{ productId: 'basic', quantity: 1 }], products, 500).totalCents).toBe(3000);
    expect(() => priceCart([{ productId: 'basic', quantity: 1 }], products, 4000)).toThrow(DomainError);
    expect(() => priceCart([{ productId: 'basic', quantity: 1 }], products, -1)).toThrow(DomainError);
  });

  it('rejects empty orders, bad quantities and unavailable products', () => {
    expect(() => priceCart([], products)).toThrow(DomainError);
    expect(() => priceCart([{ productId: 'basic', quantity: 0 }], products)).toThrow(DomainError);
    expect(() => priceCart([{ productId: 'basic', quantity: 1.5 }], products)).toThrow(DomainError);
    expect(() => priceCart([{ productId: 'old', quantity: 1 }], products)).toThrow(DomainError);
    expect(() => priceCart([{ productId: 'nope', quantity: 1 }], products)).toThrow(DomainError);
  });
});

describe('settlePayment', () => {
  it('calculates change for cash', () => {
    expect(settlePayment('cash', 3500, 5000)).toEqual({ amountReceivedCents: 5000, changeCents: 1500 });
  });
  it('rejects short cash', () => {
    expect(() => settlePayment('cash', 3500, 3000)).toThrow(DomainError);
    expect(() => settlePayment('cash', 3500)).toThrow(DomainError);
  });
  it('ignores tendered amount for card and EFT', () => {
    expect(settlePayment('card', 3500, 9999)).toEqual({});
  });
});

describe('ingredientUsage (recipes)', () => {
  it('sums usage across lines and costs it', () => {
    const { usage, costCents } = ingredientUsage(
      [{ productId: 'basic', quantity: 2 }, { productId: 'russian', quantity: 1 }],
      recipes,
      ingredients,
    );
    const bread = usage.find((u) => u.ingredientId === 'bread')!;
    const chips = usage.find((u) => u.ingredientId === 'chips')!;
    expect(bread.quantity).toBe(0.75);
    expect(chips.quantity).toBe(0.45);
    expect(usage.find((u) => u.ingredientId === 'russian')?.quantity).toBe(1);
    expect(costCents).toBe(Math.round(0.75 * 450) + Math.round(0.45 * 2000) + 900);
  });

  it('treats products without a recipe as having no ingredient cost', () => {
    expect(ingredientUsage([{ productId: 'other', quantity: 3 }], recipes, ingredients)).toEqual({ usage: [], costCents: 0 });
  });

  it('avoids floating point drift', () => {
    const { usage } = ingredientUsage([{ productId: 'basic', quantity: 3 }], recipes, ingredients);
    expect(usage.find((u) => u.ingredientId === 'chips')?.quantity).toBe(0.45);
  });
});

describe('cash reconciliation', () => {
  const session = {
    openingFloatCents: 50000,
    cashSalesCents: 120000,
    cashRefundsCents: 3500,
    approvedCashExpensesCents: 8000,
    cashPayoutsCents: 20000,
  };

  it('expected = float + cash sales − refunds − approved cash expenses − payouts', () => {
    expect(expectedCash(session)).toBe(50000 + 120000 - 3500 - 8000 - 20000);
  });

  it('balanced count needs no explanation', () => {
    const r = reconcileCash(session, 138500, 2000);
    expect(r.differenceCents).toBe(0);
    expect(r.requiresExplanation).toBe(false);
    expect(r.isAlert).toBe(false);
  });

  it('short cash is negative and needs an explanation', () => {
    const r = reconcileCash(session, 138000, 2000);
    expect(r.differenceCents).toBe(-500);
    expect(r.requiresExplanation).toBe(true);
    expect(r.isAlert).toBe(false);
  });

  it('alerts above the threshold, over or short', () => {
    expect(reconcileCash(session, 130000, 2000).isAlert).toBe(true);
    expect(reconcileCash(session, 145000, 2000).isAlert).toBe(true);
  });
});

describe('stock', () => {
  it('computes count variance against theoretical stock at unit cost', () => {
    const line = stockCountLine(ingredient('bread', 450, 20), 18.5);
    expect(line.varianceQty).toBe(-1.5);
    expect(line.varianceCents).toBe(-675);
  });

  it('rejects negative counts', () => {
    expect(() => stockCountLine(ingredient('bread', 450), -1)).toThrow(DomainError);
  });

  it('flags low stock at or below reorder level', () => {
    expect(isLowStock({ currentQty: 10, reorderLevel: 10, active: true })).toBe(true);
    expect(isLowStock({ currentQty: 11, reorderLevel: 10, active: true })).toBe(false);
    expect(isLowStock({ currentQty: 0, reorderLevel: 10, active: false })).toBe(false);
  });
});

describe('profit', () => {
  it('separates revenue, gross profit and operating profit', () => {
    const s = {
      ...emptyDailyStats('2026-10-25'),
      grossSalesCents: 100000,
      refundsCents: 5000,
      cogsCents: 40000,
      refundedCogsCents: 2000,
      wastageCostCents: 3000,
      staffMealCostCents: 1000,
      stockAdjustmentCents: -2000,
      operatingExpensesCents: 15000,
      inventoryPurchasesCents: 60000, // inventory – must not reduce profit directly
    };
    const p = profitSummary(s);
    expect(p.netRevenueCents).toBe(95000);
    expect(p.costOfSalesCents).toBe(38000);
    expect(p.grossProfitCents).toBe(57000);
    expect(p.stockLossesCents).toBe(6000);
    expect(p.operatingProfitCents).toBe(57000 - 6000 - 15000);
    expect(p.grossMarginPercent).toBe(60);
  });

  it('sums daily stats including nested maps', () => {
    const a = { ...emptyDailyStats('2026-10-24'), orders: 2, byMethod: { cash: 100, card: 0, eft: 0 }, products: { basic: { name: 'Basic', qty: 2, revenueCents: 7000 } } };
    const b = { ...emptyDailyStats('2026-10-25'), orders: 3, byMethod: { cash: 50, card: 25, eft: 0 }, products: { basic: { name: 'Basic', qty: 1, revenueCents: 3500 } } };
    const t = sumStats([a, b]);
    expect(t.orders).toBe(5);
    expect(t.byMethod).toEqual({ cash: 150, card: 25, eft: 0 });
    expect(t.products['basic'].qty).toBe(3);
  });
});

describe('dates', () => {
  it('uses the business time zone for day keys', () => {
    // 23:30 UTC on 24 Oct is 01:30 on 25 Oct in Johannesburg (UTC+2)
    const d = new Date('2026-10-24T23:30:00Z');
    expect(dayKey(d)).toBe('2026-10-25');
    expect(localHour(d)).toBe(1);
  });

  it('builds inclusive day ranges', () => {
    expect(dayRange('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  });
});

describe('offline sales', () => {
  const now = Date.parse('2026-10-25T12:00:00Z');
  it('uses server time for live sales', () => {
    expect(resolveSoldAt(undefined, now)).toEqual({ at: new Date(now), offline: false });
  });
  it('keeps the device time for queued sales and flags them offline', () => {
    const r = resolveSoldAt(now - 30 * 60_000, now);
    expect(r.at.getTime()).toBe(now - 30 * 60_000);
    expect(r.offline).toBe(true);
  });
  it('tolerates small clock skew but rejects future and stale sales', () => {
    expect(resolveSoldAt(now + 60_000, now).at.getTime()).toBe(now);
    expect(() => resolveSoldAt(now + 10 * 60_000, now)).toThrow(DomainError);
    expect(() => resolveSoldAt(now - 25 * 60 * 60_000, now)).toThrow(DomainError);
  });
});

describe('reordering', () => {
  it('tops stock up to twice the reorder level', () => {
    expect(reorderQty({ currentQty: 4, reorderLevel: 10 })).toBe(16);
    expect(reorderQty({ currentQty: -2, reorderLevel: 10 })).toBe(20);
    expect(reorderQty({ currentQty: 30, reorderLevel: 10 })).toBe(0);
    expect(reorderQty({ currentQty: 0.4, reorderLevel: 1 })).toBe(2);
  });
  it('formats South African numbers for WhatsApp', () => {
    expect(waPhone('082 123 4567')).toBe('27821234567');
    expect(waPhone('+27 82 123 4567')).toBe('27821234567');
    expect(waPhone('12345')).toBeNull();
  });
});

describe('order queue', () => {
  it('leaves extras off the queue unless switched on', () => {
    expect(inOrderQueue({ category: 'kota' })).toBe(true);
    expect(inOrderQueue({ category: 'extras' })).toBe(false);
    expect(inOrderQueue({ category: 'extras', orderQueue: true })).toBe(true);
    expect(inOrderQueue({ category: 'drinks', orderQueue: false })).toBe(false);
  });
});

describe('stock never goes negative', () => {
  it('applies normal changes', () => {
    expect(clampStockChange(10, -3)).toEqual({ applied: -3, newQty: 7, shortfall: 0, ranOut: false });
    expect(clampStockChange(0, 5)).toEqual({ applied: 5, newQty: 5, shortfall: 0, ranOut: false });
  });
  it('stops at zero and reports the shortfall', () => {
    expect(clampStockChange(2, -5)).toEqual({ applied: -2, newQty: 0, shortfall: 3, ranOut: true });
    expect(clampStockChange(0, -1)).toEqual({ applied: 0, newQty: 0, shortfall: 1, ranOut: false });
  });
  it('flags reaching exactly zero', () => {
    expect(clampStockChange(1, -1).ranOut).toBe(true);
  });
  it('treats old negative balances as zero and avoids -0 from rounding', () => {
    expect(clampStockChange(-4, 10).newQty).toBe(10);
    expect(Object.is(clampStockChange(0.0001, -0.0001).newQty, -0)).toBe(false);
  });
});
