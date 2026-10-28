import { onCall } from 'firebase-functions/v2/https';
import { ApiRequest, ApiResponse } from './shared/api';
import { DomainError, requireText, roundQty } from './shared/domain';
import { assertCents, formatZar } from './shared/money';
import { EMPLOYEE_STOCK_TYPES, Ingredient, PurchaseLine, StockMovementType, Supplier } from './shared/models';
import { FieldValue, assertReceiptPath, audit, col, db, fail, findOpenShift, handle, localTime, notify, optionalText, readSettings, requireCaller, todayKey } from './common';
import { applyStockChange, bumpStats, inc, statsRef } from './effects';

function assertQty(q: unknown, field: string, allowNegative = false): number {
  const n = Number(q);
  if (!Number.isFinite(n) || n === 0 || Math.abs(n) > 100_000 || (!allowNegative && n < 0)) {
    throw new DomainError(`${field} must be a ${allowNegative ? 'non-zero' : 'positive'} number`);
  }
  return roundQty(n);
}

/**
 * Records a stock delivery. Ingredient unit cost is updated to a weighted
 * average so cost of sales follows real purchase prices. Cash paid from the
 * till is deducted from the expected cash balance.
 */
export const recordPurchase = onCall<ApiRequest<'recordPurchase'>, Promise<ApiResponse<'recordPurchase'>>>((req) =>
  handle(async () => {
    const caller = await requireCaller(req);
    const d = req.data;
    const b = caller.businessId;
    const rawLines = Array.isArray(d.lines) ? d.lines : [];
    if (rawLines.length === 0 || rawLines.length > 50) throw new DomainError('Add between 1 and 50 items');
    if (new Set(rawLines.map((l) => l.ingredientId)).size !== rawLines.length) throw new DomainError('Each ingredient may appear once');
    const paidFromTillCents = assertCents(d.paidFromTillCents ?? 0, 'Cash from till');
    const invoiceRef = optionalText(d.invoiceRef, 'Invoice number', 60);
    const receiptPath = assertReceiptPath(d.receiptPath, caller);

    return db.runTransaction(async (tx) => {
      const snaps = await tx.getAll(...rawLines.map((l) => col(b, 'ingredients').doc(String(l.ingredientId))));
      const supplier = d.supplierId ? ((await tx.get(col(b, 'suppliers').doc(d.supplierId))).data() as Supplier | undefined) : undefined;
      if (d.supplierId && !supplier) throw new DomainError('Unknown supplier');
      const settings = await readSettings(b, tx);
      const shift = await findOpenShift(tx, caller);
      if (paidFromTillCents > 0 && !shift) fail('failed-precondition', 'A shift must be open to pay from the till');

      const lines: PurchaseLine[] = [];
      const loaded: Ingredient[] = [];
      rawLines.forEach((l, i) => {
        if (!snaps[i].exists) throw new DomainError('Unknown ingredient');
        const ingredient = { ...(snaps[i].data() as Ingredient), id: snaps[i].id };
        const quantity = assertQty(l.quantity, `Quantity of ${ingredient.name}`);
        // No cost given (e.g. a cashier who doesn't know the price): use the current cost, leaving it unchanged.
        const unitCostCents =
          l.unitCostCents === undefined || l.unitCostCents === null
            ? ingredient.unitCostCents
            : assertCents(l.unitCostCents, `Unit cost of ${ingredient.name}`, { max: 10_000_000 });
        lines.push({ ingredientId: ingredient.id, ingredientName: ingredient.name, quantity, unitCostCents, lineTotalCents: Math.round(quantity * unitCostCents) });
        loaded.push(ingredient);
      });
      const totalCents = lines.reduce((s, l) => s + l.lineTotalCents, 0);
      if (paidFromTillCents > totalCents) throw new DomainError('Cash from till cannot be more than the delivery total');

      const ref = col(b, 'purchases').doc();
      tx.set(ref, {
        id: ref.id,
        ...(supplier ? { supplierId: d.supplierId, supplierName: supplier.name } : {}),
        lines,
        totalCents,
        paidFromTillCents,
        ...(invoiceRef ? { invoiceRef } : {}),
        ...(receiptPath ? { receiptPath } : {}),
        shiftId: shift?.id ?? null,
        createdBy: caller.uid,
        createdByName: caller.name,
        createdAt: FieldValue.serverTimestamp(),
        dayKey: todayKey(settings),
      });

      lines.forEach((line, i) => {
        const ing = loaded[i];
        const onHand = Math.max(ing.currentQty, 0);
        const avgCost = Math.round((onHand * ing.unitCostCents + line.quantity * line.unitCostCents) / (onHand + line.quantity));
        applyStockChange(
          tx,
          b,
          caller,
          settings,
          { ingredient: ing, qtyChange: line.quantity, type: 'purchase', refType: 'purchase', refId: ref.id, shiftId: shift?.id, unitCostCents: line.unitCostCents },
          // only re-average the cost when a different price was entered
          line.unitCostCents === ing.unitCostCents ? {} : { unitCostCents: avgCost },
        );
      });

      if (paidFromTillCents > 0 && shift) {
        tx.update(col(b, 'cashSessions').doc(shift.cashSessionId), {
          cashPayoutsCents: inc(paidFromTillCents),
          payouts: FieldValue.arrayUnion({
            amountCents: paidFromTillCents,
            reason: `Stock delivery${supplier ? ` – ${supplier.name}` : ''}${invoiceRef ? ` (${invoiceRef})` : ''}`,
            by: caller.uid,
            byName: caller.name,
            at: Date.now(),
          }),
        });
        notify(tx, b, settings, {
          type: 'tillPurchase',
          severity: 'info',
          title: `Stock paid from till: ${formatZar(paidFromTillCents)}`,
          message: `${caller.name} recorded a delivery of ${lines.length} item(s)${supplier ? ` from ${supplier.name}` : ''}.`,
          details: [
            { label: 'Supplier', value: supplier?.name ?? 'Not listed' },
            ...lines.map((l) => ({ label: l.ingredientName, value: `${l.quantity} × ${formatZar(l.unitCostCents)} = ${formatZar(l.lineTotalCents)}` })),
            { label: 'Delivery total', value: formatZar(totalCents) },
            { label: 'Cash taken from till', value: formatZar(paidFromTillCents), tone: 'bad' },
            { label: 'Invoice / slip', value: invoiceRef ?? (receiptPath ? 'Photo attached' : 'None') },
            { label: 'When', value: localTime(new Date(), settings) },
          ],
          actorName: caller.name,
          action: 'Check the invoice matches. Stock levels went up and the till cash expected at close went down by this amount.',
          link: '/stock',
        });
      }
      bumpStats(tx, b, todayKey(settings), { inventoryPurchasesCents: inc(totalCents) });
      audit(tx, b, caller, 'stock.purchase', 'purchases', ref.id, { totalCents, paidFromTillCents, lines: lines.length });
      return { purchaseId: ref.id };
    });
  }),
);

/**
 * Wastage, staff meals and complimentary items are recorded directly with a
 * reason. Adjustments by an employee become owner approvals.
 */
export const recordStockMovement = onCall<ApiRequest<'recordStockMovement'>, Promise<ApiResponse<'recordStockMovement'>>>((req) =>
  handle(async () => {
    const caller = await requireCaller(req);
    const d = req.data;
    const b = caller.businessId;
    const type = d.type as StockMovementType;
    if (type !== 'adjustment' && !EMPLOYEE_STOCK_TYPES.includes(type)) throw new DomainError('Invalid stock movement type');
    const quantity = assertQty(d.quantity, 'Quantity', type === 'adjustment');
    const reason = requireText(d.reason, 'Reason', 3, 200);

    return db.runTransaction(async (tx) => {
      const ingSnap = await tx.get(col(b, 'ingredients').doc(String(d.ingredientId)));
      if (!ingSnap.exists) fail('not-found', 'Ingredient not found');
      const ingredient = { ...(ingSnap.data() as Ingredient), id: ingSnap.id };
      const settings = await readSettings(b, tx);
      const shift = await findOpenShift(tx, caller);
      const dayKey = todayKey(settings);
      const stats = (await tx.get(statsRef(b, dayKey))).data();

      if (type === 'adjustment' && caller.role === 'employee') {
        const ref = col(b, 'approvals').doc();
        tx.set(ref, {
          id: ref.id,
          type: 'stockAdjustment',
          status: 'pending',
          refId: ingredient.id,
          summary: `${ingredient.name}: ${quantity > 0 ? '+' : ''}${quantity} ${ingredient.unit} – ${reason}`,
          amountCents: Math.round(Math.abs(quantity) * ingredient.unitCostCents),
          payload: { ingredientId: ingredient.id, qtyChange: quantity, reason, shiftId: shift?.id ?? null },
          requestedBy: caller.uid,
          requestedByName: caller.name,
          requestedAt: FieldValue.serverTimestamp(),
        });
        audit(tx, b, caller, 'stock.adjustmentRequested', 'ingredients', ingredient.id, { quantity, reason });
        return { approvalId: ref.id };
      }

      const qtyChange = type === 'adjustment' ? quantity : -quantity;
      // Manual removals can't take more than is on hand – stock never goes below zero.
      const onHand = Math.max(ingredient.currentQty, 0);
      if (qtyChange < 0 && -qtyChange > onHand) {
        throw new DomainError(`Only ${roundQty(onHand)} ${ingredient.unit} of ${ingredient.name} in stock`);
      }
      const value = applyStockChange(tx, b, caller, settings, { ingredient, qtyChange, type, reason, shiftId: shift?.id });
      if (type === 'wastage') {
        const before = (stats?.['wastageCostCents'] as number | undefined) ?? 0;
        bumpStats(tx, b, dayKey, { wastageCostCents: inc(value) });
        const limit = settings.thresholds.wastageAlertCents;
        if (before <= limit && before + value > limit) {
          notify(tx, b, settings, {
            type: 'excessiveWastage',
            severity: 'warning',
            title: `Wastage today is over ${formatZar(limit)}`,
            message: `${caller.name} recorded ${quantity} ${ingredient.unit} ${ingredient.name} wasted (${reason}). Total today: ${formatZar(before + value)}.`,
            details: [
              { label: 'Item wasted', value: `${quantity} ${ingredient.unit} ${ingredient.name}` },
              { label: 'Value at cost', value: formatZar(value), tone: 'bad' },
              { label: 'Reason given', value: reason },
              { label: 'Wastage today so far', value: formatZar(before + value), tone: 'bad' },
              { label: 'Your daily limit', value: formatZar(limit) },
              { label: 'When', value: localTime(new Date(), settings) },
            ],
            actorName: caller.name,
            action: 'See every wastage entry in Stock › History. Change the limit in Settings › Alert thresholds.',
            link: '/stock',
          });
        }
      } else if (type === 'adjustment') {
        bumpStats(tx, b, dayKey, { stockAdjustmentCents: inc(Math.sign(qtyChange) * value) });
      } else if (type === 'staffMeal' || type === 'complimentary') {
        // Both are stock given away at cost; reported together as staff meals & comps.
        bumpStats(tx, b, dayKey, { staffMealCostCents: inc(value) });
      }
      audit(tx, b, caller, `stock.${type}`, 'ingredients', ingredient.id, { quantity: qtyChange, reason, valueCents: value });
      return {};
    });
  }),
);
