import { Cents } from './money';
import {
  CashSession,
  DailyStats,
  Ingredient,
  PaymentMethod,
  Product,
  Recipe,
  SaleLine,
  StockCountLine,
} from './models';

/**
 * Pure business rules shared by the backend (authoritative) and the Angular
 * app (previews only). No Firebase imports here so this file is easy to test.
 */

export class DomainError extends Error {}

export const MAX_LINE_QTY = 50;
export const MAX_LINES = 30;

/** Rounds stock quantities to 3 decimals to avoid floating point drift. */
export function roundQty(q: number): number {
  return Math.round(q * 1000) / 1000;
}

export interface CartItem {
  productId: string;
  quantity: number;
}

export interface PricedSale {
  lines: SaleLine[];
  subtotalCents: Cents;
  discountCents: Cents;
  totalCents: Cents;
}

/** Prices a cart from the authoritative product list. Rejects unknown/inactive items. */
export function priceCart(items: CartItem[], products: Map<string, Product>, discountCents = 0): PricedSale {
  if (!Array.isArray(items) || items.length === 0) throw new DomainError('The order is empty');
  if (items.length > MAX_LINES) throw new DomainError('Too many lines in one order');

  const merged = new Map<string, number>();
  for (const item of items) {
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_LINE_QTY) {
      throw new DomainError(`Invalid quantity for ${item.productId}`);
    }
    merged.set(item.productId, (merged.get(item.productId) ?? 0) + item.quantity);
  }

  const lines: SaleLine[] = [];
  for (const [productId, quantity] of merged) {
    const product = products.get(productId);
    if (!product || !product.active) throw new DomainError(`Product is not available: ${productId}`);
    lines.push({
      productId,
      name: product.name,
      quantity,
      unitPriceCents: product.priceCents,
      lineTotalCents: product.priceCents * quantity,
    });
  }

  const subtotalCents = lines.reduce((sum, l) => sum + l.lineTotalCents, 0);
  if (!Number.isSafeInteger(discountCents) || discountCents < 0 || discountCents > subtotalCents) {
    throw new DomainError('Discount must be between R0 and the order subtotal');
  }
  return { lines, subtotalCents, discountCents, totalCents: subtotalCents - discountCents };
}

/** Extras (toppings, add-ons) are not prepared as separate orders unless the owner says so. */
export function inOrderQueue(p: Pick<Product, 'category' | 'orderQueue'>): boolean {
  return p.orderQueue ?? p.category !== 'extras';
}

export function discountPercent(discountCents: Cents, subtotalCents: Cents): number {
  return subtotalCents === 0 ? 0 : (discountCents / subtotalCents) * 100;
}

/** Validates the tendered cash and returns change. Card/EFT must equal the total. */
export function settlePayment(
  method: PaymentMethod,
  totalCents: Cents,
  amountReceivedCents?: Cents,
): { amountReceivedCents?: Cents; changeCents?: Cents } {
  if (method !== 'cash') return {};
  if (!Number.isSafeInteger(amountReceivedCents) || (amountReceivedCents as number) < totalCents) {
    throw new DomainError('Cash received must be at least the order total');
  }
  const received = amountReceivedCents as number;
  if (received > totalCents + 200_000) throw new DomainError('Cash received looks wrong (more than R2,000 change)');
  return { amountReceivedCents: received, changeCents: received - totalCents };
}

export interface IngredientUsage {
  ingredientId: string;
  quantity: number;
  costCents: Cents;
}

/** Expected ingredient usage and cost for a set of sale lines, using product recipes. */
export function ingredientUsage(
  lines: Pick<SaleLine, 'productId' | 'quantity'>[],
  recipes: Map<string, Recipe>,
  ingredients: Map<string, Ingredient>,
): { usage: IngredientUsage[]; costCents: Cents } {
  const qty = new Map<string, number>();
  for (const line of lines) {
    const recipe = recipes.get(line.productId);
    if (!recipe) continue;
    for (const r of recipe.lines) {
      if (!(r.quantity > 0)) continue;
      qty.set(r.ingredientId, roundQty((qty.get(r.ingredientId) ?? 0) + r.quantity * line.quantity));
    }
  }
  const usage: IngredientUsage[] = [];
  for (const [ingredientId, quantity] of qty) {
    const ing = ingredients.get(ingredientId);
    usage.push({ ingredientId, quantity, costCents: Math.round(quantity * (ing?.unitCostCents ?? 0)) });
  }
  return { usage, costCents: usage.reduce((s, u) => s + u.costCents, 0) };
}

/** Estimated cost of one unit of a product from its recipe. */
export function productUnitCost(recipe: Recipe | undefined, ingredients: Map<string, Ingredient>): Cents {
  if (!recipe) return 0;
  return ingredientUsage([{ productId: recipe.productId, quantity: 1 }], new Map([[recipe.productId, recipe]]), ingredients)
    .costCents;
}

/**
 * Expected cash in the till:
 *   opening float + cash sales − cash refunds − approved cash expenses − cash paid out
 */
export function expectedCash(
  s: Pick<
    CashSession,
    'openingFloatCents' | 'cashSalesCents' | 'cashRefundsCents' | 'approvedCashExpensesCents' | 'cashPayoutsCents'
  >,
): Cents {
  return s.openingFloatCents + s.cashSalesCents - s.cashRefundsCents - s.approvedCashExpensesCents - s.cashPayoutsCents;
}

export interface CashCloseResult {
  expectedCashCents: Cents;
  differenceCents: Cents; // counted − expected; negative = cash short
  requiresExplanation: boolean;
  isAlert: boolean;
}

export function reconcileCash(
  session: Parameters<typeof expectedCash>[0],
  countedCashCents: Cents,
  alertThresholdCents: Cents,
): CashCloseResult {
  const expectedCashCents = expectedCash(session);
  const differenceCents = countedCashCents - expectedCashCents;
  return {
    expectedCashCents,
    differenceCents,
    requiresExplanation: differenceCents !== 0,
    isAlert: Math.abs(differenceCents) > alertThresholdCents,
  };
}

export function stockCountLine(ingredient: Ingredient, countedQty: number): StockCountLine {
  if (!(countedQty >= 0) || !Number.isFinite(countedQty)) throw new DomainError(`Invalid count for ${ingredient.name}`);
  const varianceQty = roundQty(countedQty - ingredient.currentQty);
  return {
    ingredientId: ingredient.id,
    ingredientName: ingredient.name,
    unit: ingredient.unit,
    theoreticalQty: roundQty(ingredient.currentQty),
    countedQty: roundQty(countedQty),
    varianceQty,
    varianceCents: Math.round(varianceQty * ingredient.unitCostCents),
  };
}

export function isLowStock(i: Pick<Ingredient, 'currentQty' | 'reorderLevel' | 'active'>): boolean {
  return i.active && i.currentQty <= i.reorderLevel;
}

export function emptyDailyStats(dayKey: string): DailyStats {
  return {
    dayKey,
    grossSalesCents: 0,
    discountsCents: 0,
    refundsCents: 0,
    orders: 0,
    refundCount: 0,
    byMethod: { cash: 0, card: 0, eft: 0 },
    cogsCents: 0,
    refundedCogsCents: 0,
    operatingExpensesCents: 0,
    inventoryPurchasesCents: 0,
    wastageCostCents: 0,
    staffMealCostCents: 0,
    stockAdjustmentCents: 0,
    products: {},
    hourly: {},
  };
}

/** Normalises a possibly partial stats document (counters are created lazily). */
export function normaliseStats(partial: Partial<DailyStats> & { dayKey: string }): DailyStats {
  const base = emptyDailyStats(partial.dayKey);
  return {
    ...base,
    ...partial,
    byMethod: { ...base.byMethod, ...(partial.byMethod ?? {}) },
    products: partial.products ?? {},
    hourly: partial.hourly ?? {},
  };
}

export function sumStats(days: DailyStats[]): DailyStats {
  const total = emptyDailyStats(days.length ? `${days[0].dayKey}..${days[days.length - 1].dayKey}` : '');
  for (const d of days.map(normaliseStats)) {
    total.grossSalesCents += d.grossSalesCents;
    total.discountsCents += d.discountsCents;
    total.refundsCents += d.refundsCents;
    total.orders += d.orders;
    total.refundCount += d.refundCount;
    total.cogsCents += d.cogsCents;
    total.refundedCogsCents += d.refundedCogsCents;
    total.operatingExpensesCents += d.operatingExpensesCents;
    total.inventoryPurchasesCents += d.inventoryPurchasesCents;
    total.wastageCostCents += d.wastageCostCents;
    total.staffMealCostCents += d.staffMealCostCents;
    total.stockAdjustmentCents += d.stockAdjustmentCents;
    for (const m of Object.keys(total.byMethod) as PaymentMethod[]) total.byMethod[m] += d.byMethod[m] ?? 0;
    for (const [id, p] of Object.entries(d.products)) {
      const t = (total.products[id] ??= { name: p.name, qty: 0, revenueCents: 0 });
      t.qty += p.qty;
      t.revenueCents += p.revenueCents;
    }
    for (const [h, c] of Object.entries(d.hourly)) total.hourly[h] = (total.hourly[h] ?? 0) + c;
  }
  return total;
}

export interface ProfitSummary {
  /** money taken from customers after discounts and refunds – NOT profit */
  netRevenueCents: Cents;
  /** estimated ingredient cost of what was sold */
  costOfSalesCents: Cents;
  /** net revenue − cost of sales */
  grossProfitCents: Cents;
  /** wastage + staff meals + net stock count losses, at cost */
  stockLossesCents: Cents;
  operatingExpensesCents: Cents;
  /** gross profit − stock losses − operating expenses */
  operatingProfitCents: Cents;
  grossMarginPercent: number;
}

/**
 * Profit is estimated from recipe costs. Ingredient purchases are inventory,
 * not expenses – they are expensed through cost of sales and stock losses, so
 * counting them as operating expenses would double count.
 */
export function profitSummary(s: DailyStats): ProfitSummary {
  const netRevenueCents = s.grossSalesCents - s.refundsCents;
  const costOfSalesCents = s.cogsCents - s.refundedCogsCents;
  const grossProfitCents = netRevenueCents - costOfSalesCents;
  const stockLossesCents = s.wastageCostCents + s.staffMealCostCents - s.stockAdjustmentCents;
  const operatingProfitCents = grossProfitCents - stockLossesCents - s.operatingExpensesCents;
  return {
    netRevenueCents,
    costOfSalesCents,
    grossProfitCents,
    stockLossesCents,
    operatingExpensesCents: s.operatingExpensesCents,
    operatingProfitCents,
    grossMarginPercent: netRevenueCents > 0 ? Math.round((grossProfitCents / netRevenueCents) * 1000) / 10 : 0,
  };
}

/** Local calendar day (YYYY-MM-DD) in the business time zone. */
export function dayKey(date: Date, timeZone = 'Africa/Johannesburg'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** Local hour (0–23) in the business time zone. */
export function localHour(date: Date, timeZone = 'Africa/Johannesburg'): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(date));
}

/** Local weekday (0 = Sunday) in the business time zone. */
export function localWeekday(date: Date, timeZone = 'Africa/Johannesburg'): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
}

/** Inclusive list of day keys between two YYYY-MM-DD strings. */
export function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  while (d <= end && out.length < 400) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export function requireText(value: unknown, field: string, min = 3, max = 500): string {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
    throw new DomainError(`${field} is required (${min}–${max} characters)`);
  }
  return value.trim();
}

/** Sales may be queued offline for at most this long before they must sync. */
export const MAX_OFFLINE_MS = 24 * 60 * 60 * 1000;

/**
 * Works out when a sale happened. Queued offline sales carry the device time;
 * it must be in the past (small clock skew allowed) and no older than 24 hours.
 */
export function resolveSoldAt(soldAtMillis: number | undefined, nowMillis: number): { at: Date; offline: boolean } {
  if (soldAtMillis === undefined || soldAtMillis === null) return { at: new Date(nowMillis), offline: false };
  if (!Number.isFinite(soldAtMillis)) throw new DomainError('Invalid sale time');
  if (soldAtMillis > nowMillis + 5 * 60_000) throw new DomainError('Sale time is in the future – check the phone clock');
  if (nowMillis - soldAtMillis > MAX_OFFLINE_MS) throw new DomainError('Offline sale is older than 24 hours – ask the owner to record it');
  const at = new Date(Math.min(soldAtMillis, nowMillis));
  return { at, offline: nowMillis - at.getTime() > 2 * 60_000 };
}

/** Suggested order quantity: top the item up to twice its reorder level. */
export function reorderQty(i: Pick<Ingredient, 'currentQty' | 'reorderLevel'>): number {
  const target = Math.max(i.reorderLevel * 2, i.reorderLevel + 1);
  return Math.max(0, Math.ceil(target - Math.max(i.currentQty, 0)));
}

/** Converts a South African number (082 123 4567, +27 82…) to WhatsApp's 27821234567 form. */
export function waPhone(phone: string | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (/^0\d{9}$/.test(digits)) return '27' + digits.slice(1);
  if (/^27\d{9}$/.test(digits)) return digits;
  return null;
}

export interface ClampedStockChange {
  /** change actually applied to the balance */
  applied: number;
  /** balance after the change – never below zero */
  newQty: number;
  /** amount that could not be taken because stock ran out (0 if none) */
  shortfall: number;
  /** this change took the item from in stock to empty */
  ranOut: boolean;
}

/**
 * Stock never goes below zero. A removal larger than what is on hand empties
 * the item and reports the rest as a shortfall (e.g. a delivery that was never
 * recorded). Older negative balances are treated as zero.
 */
export function clampStockChange(currentQty: number, qtyChange: number): ClampedStockChange {
  const before = Math.max(roundQty(currentQty), 0);
  const requested = roundQty(qtyChange);
  const applied = before + requested < 0 ? -before : requested;
  const newQty = Math.max(roundQty(before + applied), 0);
  // `|| 0` turns -0 into 0, so a balance can never show as "-0"
  return {
    applied: roundQty(applied) || 0,
    newQty: newQty || 0,
    shortfall: roundQty(applied - requested) || 0,
    ranOut: before > 0 && newQty === 0,
  };
}
