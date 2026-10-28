import { Transaction } from 'firebase-admin/firestore';
import { clampStockChange, reorderQty } from './shared/domain';
import { formatZar } from './shared/money';
import { BusinessSettings, CashSession, EXPENSE_INVENTORY_CATEGORY, Expense, Ingredient, Sale, StockMovementType } from './shared/models';
import { Caller, FieldValue, col, localTime, notify, todayKey } from './common';

/**
 * Write helpers shared by several functions. Callers must perform all
 * transaction reads first and pass the loaded documents in. Each helper writes
 * any given document at most once.
 */

export function statsRef(businessId: string, dayKey: string) {
  return col(businessId, 'dailyStats').doc(dayKey);
}

/** Merges counter increments into a dailyStats document (nested maps allowed). */
export function bumpStats(tx: Transaction, businessId: string, dayKey: string, increments: Record<string, unknown>): void {
  tx.set(statsRef(businessId, dayKey), { dayKey, ...increments }, { merge: true });
}

export const inc = (n: number) => FieldValue.increment(n);

export interface StockChange {
  ingredient: Ingredient;
  qtyChange: number;
  type: StockMovementType;
  reason?: string;
  refType?: 'sale' | 'purchase' | 'approval' | 'ingredient';
  refId?: string;
  shiftId?: string | null;
  /** human label for alerts, e.g. "Receipt #12" */
  label?: string;
  /** override for purchases, which carry their own cost */
  unitCostCents?: number;
}

/**
 * Appends a stock ledger entry and sets the new balance. Stock never goes below
 * zero: a removal larger than what is on hand empties the item, records the
 * rest as a shortfall, and alerts the owner. Callers must have read the
 * ingredient in this transaction. Returns the value at cost of what was applied.
 */
export function applyStockChange(
  tx: Transaction,
  businessId: string,
  actor: Caller | 'system',
  settings: BusinessSettings,
  change: StockChange,
  extraIngredientFields: Record<string, unknown> = {},
): number {
  const ing = change.ingredient;
  const { applied: qty, newQty, shortfall, ranOut } = clampStockChange(ing.currentQty, change.qtyChange);
  const unitCost = change.unitCostCents ?? ing.unitCostCents;
  const valueCents = Math.round(Math.abs(qty) * unitCost);
  const ref = col(businessId, 'stockMovements').doc();
  tx.set(ref, {
    id: ref.id,
    ingredientId: change.ingredient.id,
    ingredientName: change.ingredient.name,
    type: change.type,
    qtyChange: qty,
    unitCostCents: unitCost,
    valueCents,
    ...(change.reason ? { reason: change.reason } : {}),
    ...(shortfall ? { shortfallQty: shortfall } : {}),
    ...(change.refType ? { refType: change.refType, refId: change.refId } : {}),
    shiftId: change.shiftId ?? null,
    createdBy: actor === 'system' ? 'system' : actor.uid,
    createdByName: actor === 'system' ? 'System' : actor.name,
    createdAt: FieldValue.serverTimestamp(),
    dayKey: todayKey(settings),
  });
  // Absolute value: the ingredient was read in this transaction, so this is safe and can't go negative.
  tx.update(col(businessId, 'ingredients').doc(ing.id), { currentQty: newQty, ...extraIngredientFields });

  if (ranOut || shortfall) {
    const by = actor === 'system' ? 'System' : actor.name;
    const kinds: Record<string, string> = { sale: 'Sale', wastage: 'Wastage', staffMeal: 'Staff meal', complimentary: 'Free item', adjustment: 'Stock correction' };
    const what = change.label ?? kinds[change.type] ?? change.type;
    // one alert per item per day; a later shortfall updates it with the latest details
    notify(
      tx,
      businessId,
      settings,
      {
        type: 'outOfStock',
        severity: 'critical',
        title: `Out of stock: ${ing.name}`,
        message: shortfall
          ? `${ing.name} is at 0 but ${shortfall} ${ing.unit} more was needed. The stock in the app is probably missing a delivery.`
          : `${ing.name} has run out (0 ${ing.unit} left).`,
        details: [
          { label: 'Item', value: ing.name },
          { label: 'In stock now', value: `0 ${ing.unit}`, tone: 'bad' },
          { label: 'Emptied by', value: `${what} at ${localTime(new Date(), settings)}` },
          ...(shortfall ? [{ label: 'Needed but not in stock', value: `${shortfall} ${ing.unit}`, tone: 'bad' as const }] : []),
          { label: 'Reorder level', value: `${ing.reorderLevel} ${ing.unit}` },
          { label: 'Suggested order', value: `${reorderQty({ currentQty: 0, reorderLevel: ing.reorderLevel })} ${ing.unit}` },
          { label: 'Cost per unit', value: formatZar(ing.unitCostCents) },
        ],
        actorName: by,
        action: shortfall
          ? 'If you still have it on the shelf, a delivery was not recorded: add it with Stock › + Add. Otherwise reorder now – Stock › Levels has a WhatsApp order.'
          : 'Reorder now – Stock › Levels has a ready-made WhatsApp order. Products using it are marked "Out" on the Sell screen.',
        link: '/stock',
      },
      `outOfStock_${ing.id}_${todayKey(settings)}`,
    );
  }
  return valueCents;
}

/**
 * Applies an approved refund. Cash refunds are paid out of the till that is
 * open now, so they count against the currently open cash session.
 */
export function applyRefund(
  tx: Transaction,
  businessId: string,
  sale: Sale,
  openSession: CashSession | null,
  decidedBy: Caller,
  /** pass when the refund record is created in the same transaction (owner refunds) */
  newRefund?: Record<string, unknown>,
): void {
  const decided = { decidedBy: decidedBy.uid, decidedAt: FieldValue.serverTimestamp() };
  tx.update(
    col(businessId, 'sales').doc(sale.id),
    newRefund
      ? { status: 'refunded', refund: { ...newRefund, ...decided } }
      : { status: 'refunded', 'refund.decidedBy': decided.decidedBy, 'refund.decidedAt': decided.decidedAt },
  );
  if (sale.payment.method === 'cash' && openSession) {
    tx.update(col(businessId, 'cashSessions').doc(openSession.id), { cashRefundsCents: inc(sale.totalCents) });
  }
  // Refunds are reported against the day of the original sale.
  bumpStats(tx, businessId, sale.dayKey, {
    refundsCents: inc(sale.totalCents),
    refundedCogsCents: inc(sale.costCents),
    refundCount: inc(1),
  });
}

/** Approves or rejects an expense and keeps the linked cash session and stats in step. */
export function applyExpenseDecision(
  tx: Transaction,
  businessId: string,
  expense: Expense,
  session: CashSession | null,
  approve: boolean,
  decidedBy: Caller,
  note: string | undefined,
): void {
  tx.update(col(businessId, 'expenses').doc(expense.id), {
    status: approve ? 'approved' : 'rejected',
    decision: { by: decidedBy.uid, byName: decidedBy.name, at: FieldValue.serverTimestamp(), ...(note ? { note } : {}) },
  });

  if (expense.paidFromTill && session) {
    const approved = session.approvedCashExpensesCents + (approve ? expense.amountCents : 0);
    const update: Record<string, unknown> = {
      pendingCashExpensesCents: inc(-expense.amountCents),
      approvedCashExpensesCents: approved,
    };
    // An expense approved after the shift closed changes that shift's expected cash.
    if (session.status === 'closed' && approve && session.countedCashCents !== undefined) {
      const expected = (session.expectedCashCents ?? 0) - expense.amountCents;
      update['expectedCashCents'] = expected;
      update['differenceCents'] = session.countedCashCents - expected;
    }
    tx.update(col(businessId, 'cashSessions').doc(session.id), update);
  }

  if (approve) bumpStats(tx, businessId, expense.date, { [expenseStatsField(expense.category)]: inc(expense.amountCents) });
}

/** Ingredient purchases are inventory (expensed via cost of sales), everything else is operating cost. */
export function expenseStatsField(category: string): 'inventoryPurchasesCents' | 'operatingExpensesCents' {
  return category === EXPENSE_INVENTORY_CATEGORY ? 'inventoryPurchasesCents' : 'operatingExpensesCents';
}
