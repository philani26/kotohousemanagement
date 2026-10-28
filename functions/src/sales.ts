import { onCall } from 'firebase-functions/v2/https';
import { ApiRequest, ApiResponse } from './shared/api';
import { DomainError, clampStockChange, discountPercent, ingredientUsage, isLowStock, localHour, priceCart, requireText, resolveSoldAt, settlePayment } from './shared/domain';
import { formatZar } from './shared/money';
import { CashSession, Ingredient, PAYMENT_METHODS, Product, Recipe, Sale } from './shared/models';
import {
  FieldValue,
  Timestamp,
  audit,
  bizRef,
  col,
  db,
  fail,
  findOpenShift,
  itemsText,
  localTime,
  handle,
  notify,
  optionalText,
  readSettings,
  requireCaller,
  todayKey,
} from './common';
import { applyRefund, applyStockChange, bumpStats, inc } from './effects';

const SALE_ID = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Records a sale. Prices, totals, change, ingredient usage and cost are all
 * computed here from Firestore data – the client only sends product ids and
 * quantities. The client-generated saleId makes retries safe: a repeated call
 * returns the existing sale instead of creating a duplicate.
 */
export const recordSale = onCall<ApiRequest<'recordSale'>, Promise<ApiResponse<'recordSale'>>>((req) =>
  handle(async () => {
    const caller = await requireCaller(req);
    const d = req.data;
    if (typeof d.saleId !== 'string' || !SALE_ID.test(d.saleId)) fail('invalid-argument', 'Invalid sale id');
    if (!d.payment || !PAYMENT_METHODS.includes(d.payment.method)) fail('invalid-argument', 'Choose a payment method');
    const reference = optionalText(d.payment.reference, 'Payment reference', 60);
    const discountReason = optionalText(d.discountReason, 'Discount reason', 120);
    // Sales queued on the device while offline keep the time they were rung up.
    const soldAt = resolveSoldAt(d.soldAtMillis, Date.now());
    const b = caller.businessId;

    return db.runTransaction(async (tx) => {
      // ---- reads ----
      const saleRef = col(b, 'sales').doc(d.saleId);
      const existing = await tx.get(saleRef);
      if (existing.exists) {
        const s = existing.data() as Sale;
        if (s.employeeId !== caller.uid) fail('already-exists', 'Duplicate sale id');
        return { saleId: s.id, receiptNo: s.receiptNo, totalCents: s.totalCents, changeCents: s.payment.changeCents ?? 0, duplicate: true };
      }

      const shift = await findOpenShift(tx, caller);
      if (!shift) fail('failed-precondition', 'Open a shift before recording sales');
      if (caller.role === 'employee' && shift.employeeId !== caller.uid) fail('permission-denied', 'This is not your shift');

      const items = Array.isArray(d.items) ? d.items : [];
      const productIds = [...new Set(items.map((i) => String(i.productId)))];
      if (productIds.length === 0) throw new DomainError('The order is empty');
      const productSnaps = await tx.getAll(...productIds.map((id) => col(b, 'products').doc(id)));
      const recipeSnaps = await tx.getAll(...productIds.map((id) => col(b, 'recipes').doc(id)));
      const products = new Map(productSnaps.filter((s) => s.exists).map((s) => [s.id, { ...(s.data() as Product), id: s.id }]));
      const recipes = new Map(recipeSnaps.filter((s) => s.exists).map((s) => [s.id, s.data() as Recipe]));

      const ingredientIds = [...new Set([...recipes.values()].flatMap((r) => r.lines.map((l) => l.ingredientId)))];
      const ingredientSnaps = ingredientIds.length ? await tx.getAll(...ingredientIds.map((id) => col(b, 'ingredients').doc(id))) : [];
      const ingredients = new Map(ingredientSnaps.filter((s) => s.exists).map((s) => [s.id, { ...(s.data() as Ingredient), id: s.id }]));

      const settings = await readSettings(b, tx);
      const business = await tx.get(bizRef(b));

      // ---- business rules ----
      const priced = priceCart(items, products, d.discountCents ?? 0);
      const pct = discountPercent(priced.discountCents, priced.subtotalCents);
      if (priced.discountCents > 0) {
        if (!discountReason) throw new DomainError('Give a reason for the discount');
        if (caller.role === 'employee' && pct > settings.maxEmployeeDiscountPercent) {
          fail('permission-denied', `Discounts above ${settings.maxEmployeeDiscountPercent}% need the owner`);
        }
      }
      const payment = settlePayment(d.payment.method, priced.totalCents, d.payment.amountReceivedCents);
      const { usage, costCents } = ingredientUsage(priced.lines, recipes, ingredients);

      // ---- writes ----
      const receiptNo = ((business.get('receiptCounter') as number | undefined) ?? 0) + 1;
      const now = soldAt.at;
      const dayKey = todayKey(settings, now);
      const priceChanged = d.expectedTotalCents !== undefined && d.expectedTotalCents !== priced.totalCents;
      const sale: Omit<Sale, 'createdAt'> = {
        id: d.saleId,
        receiptNo,
        shiftId: shift.id,
        employeeId: caller.uid,
        employeeName: caller.name,
        lines: priced.lines,
        subtotalCents: priced.subtotalCents,
        discountCents: priced.discountCents,
        ...(discountReason ? { discountReason } : {}),
        totalCents: priced.totalCents,
        costCents,
        payment: { method: d.payment.method, ...payment, ...(reference ? { reference } : {}), verified: d.payment.method === 'cash' },
        status: 'completed',
        dayKey,
        ...(soldAt.offline ? { offline: true } : {}),
      };
      tx.set(saleRef, { ...sale, soldAt: Timestamp.fromDate(now), createdAt: FieldValue.serverTimestamp() });
      tx.update(bizRef(b), { receiptCounter: receiptNo });

      for (const u of usage) {
        const ingredient = ingredients.get(u.ingredientId);
        if (!ingredient) continue;
        applyStockChange(tx, b, caller, settings, {
          ingredient,
          qtyChange: -u.quantity,
          type: 'sale',
          refType: 'sale',
          refId: d.saleId,
          shiftId: shift.id,
          label: `Receipt #${receiptNo}`,
        });
        const after = { ...ingredient, currentQty: clampStockChange(ingredient.currentQty, -u.quantity).newQty };
        // reaching 0 raises the out-of-stock alert instead
        if (!isLowStock(ingredient) && isLowStock(after) && after.currentQty > 0) {
          notify(tx, b, settings, {
            type: 'lowStock',
            severity: 'warning',
            title: `Low stock: ${ingredient.name}`,
            message: `${ingredient.name} is down to ${after.currentQty} ${ingredient.unit} (reorder level ${ingredient.reorderLevel}).`,
            details: [
              { label: 'Item', value: ingredient.name },
              { label: 'Left (expected)', value: `${after.currentQty} ${ingredient.unit}`, tone: 'bad' },
              { label: 'Reorder level', value: `${ingredient.reorderLevel} ${ingredient.unit}` },
              { label: 'Suggested order', value: `${Math.max(0, Math.ceil(ingredient.reorderLevel * 2 - Math.max(after.currentQty, 0)))} ${ingredient.unit}` },
              { label: 'Value left at cost', value: formatZar(Math.round(Math.max(after.currentQty, 0) * ingredient.unitCostCents)) },
              { label: 'Triggered by', value: `Receipt #${receiptNo} at ${localTime(now, settings)}` },
            ],
            actorName: caller.name,
            action: 'Order more from your supplier – Stock › Levels has a ready-made WhatsApp order.',
            link: '/stock',
          });
        }
      }

      const methodField = `${d.payment.method}SalesCents` as const;
      tx.update(col(b, 'cashSessions').doc(shift.cashSessionId), { [methodField]: inc(priced.totalCents) });
      tx.update(col(b, 'shifts').doc(shift.id), { lastSaleAt: Timestamp.fromDate(now) });

      const productIncrements: Record<string, unknown> = {};
      for (const l of priced.lines) {
        productIncrements[l.productId] = { name: l.name, qty: inc(l.quantity), revenueCents: inc(l.lineTotalCents) };
      }
      bumpStats(tx, b, dayKey, {
        grossSalesCents: inc(priced.totalCents),
        discountsCents: inc(priced.discountCents),
        orders: inc(1),
        cogsCents: inc(costCents),
        byMethod: { [d.payment.method]: inc(priced.totalCents) },
        products: productIncrements,
        hourly: { [String(localHour(now, settings.timezone)).padStart(2, '0')]: inc(priced.totalCents) },
      });

      if (priced.discountCents > 0) {
        audit(tx, b, caller, 'sale.discounted', 'sales', d.saleId, { discountCents: priced.discountCents, percent: Math.round(pct), reason: discountReason });
        if (pct >= settings.thresholds.discountAlertPercent) {
          notify(tx, b, settings, {
            type: 'largeDiscount',
            severity: 'warning',
            title: `Discount of ${Math.round(pct)}% given`,
            message: `${caller.name} discounted receipt #${receiptNo} by ${formatZar(priced.discountCents)}: ${discountReason}`,
            details: [
              { label: 'Receipt', value: `#${receiptNo} at ${localTime(now, settings)}` },
              { label: 'Items', value: itemsText(priced.lines) },
              { label: 'Full price', value: formatZar(priced.subtotalCents) },
              { label: 'Discount', value: `${formatZar(priced.discountCents)} (${Math.round(pct)}%)`, tone: 'bad' },
              { label: 'Customer paid', value: `${formatZar(priced.totalCents)} by ${d.payment.method}` },
              { label: 'Reason given', value: discountReason ?? '' },
            ],
            actorName: caller.name,
            action: 'Check the reason is genuine. Repeated discounts by one person are worth a conversation.',
            link: '/sales',
          });
        }
      }
      if (priceChanged) {
        notify(tx, b, settings, {
          type: 'priceMismatch',
          severity: 'warning',
          title: `Offline sale #${receiptNo} total changed`,
          message: `${caller.name} charged ${formatZar(d.expectedTotalCents!)} while offline, but current prices make it ${formatZar(priced.totalCents)}. Check the till.`,
          details: [
            { label: 'Receipt', value: `#${receiptNo}` },
            { label: 'Sold at (offline)', value: localTime(now, settings) },
            { label: 'Items', value: itemsText(priced.lines) },
            { label: 'Charged to customer', value: formatZar(d.expectedTotalCents!) },
            { label: 'Recorded at current prices', value: formatZar(priced.totalCents) },
            { label: 'Difference', value: formatZar(priced.totalCents - d.expectedTotalCents!), tone: 'bad' },
          ],
          actorName: caller.name,
          action: 'Prices changed while the phone was offline. Expect the till to differ by this amount at cash-up.',
          link: '/sales',
        });
      }
      audit(tx, b, caller, 'sale.recorded', 'sales', d.saleId, {
        receiptNo,
        totalCents: priced.totalCents,
        method: d.payment.method,
        ...(soldAt.offline ? { offline: true, soldAt: now.toISOString() } : {}),
        ...(priceChanged ? { chargedCents: d.expectedTotalCents } : {}),
      });

      return { saleId: d.saleId, receiptNo, totalCents: priced.totalCents, changeCents: payment.changeCents ?? 0, duplicate: false };
    });
  }),
);

/**
 * Employees request refunds; the owner approves them from the approvals screen.
 * When the owner requests a refund it is applied immediately (and audited).
 */
export const requestRefund = onCall<ApiRequest<'requestRefund'>, Promise<ApiResponse<'requestRefund'>>>((req) =>
  handle(async () => {
    const caller = await requireCaller(req);
    const reason = requireText(req.data.reason, 'Refund reason', 3, 200);
    const b = caller.businessId;

    return db.runTransaction(async (tx) => {
      const saleRef = col(b, 'sales').doc(String(req.data.saleId));
      const snap = await tx.get(saleRef);
      if (!snap.exists) fail('not-found', 'Sale not found');
      const sale = snap.data() as Sale;
      if (sale.status !== 'completed') fail('failed-precondition', 'This sale has already been refunded or is awaiting approval');
      if (caller.role === 'employee' && sale.employeeId !== caller.uid) fail('permission-denied', 'You can only refund your own sales');

      const settings = await readSettings(b, tx);
      const shift = await findOpenShift(tx, caller);
      let session: CashSession | null = null;
      if (shift) session = (await tx.get(col(b, 'cashSessions').doc(shift.cashSessionId))).data() as CashSession;
      if (sale.payment.method === 'cash' && !session) fail('failed-precondition', 'A shift must be open to pay back a cash refund');

      const approvalRef = col(b, 'approvals').doc();
      const isOwner = caller.role === 'owner';
      tx.set(approvalRef, {
        id: approvalRef.id,
        type: 'refund',
        status: isOwner ? 'approved' : 'pending',
        refId: sale.id,
        summary: `Refund receipt #${sale.receiptNo} (${sale.payment.method}) – ${reason}`,
        amountCents: sale.totalCents,
        payload: { reason, method: sale.payment.method },
        requestedBy: caller.uid,
        requestedByName: caller.name,
        requestedAt: FieldValue.serverTimestamp(),
        ...(isOwner ? { decidedBy: caller.uid, decidedByName: caller.name, decidedAt: FieldValue.serverTimestamp(), note: 'Owner refund' } : {}),
      });
      const refund = { reason, requestedBy: caller.uid, requestedAt: FieldValue.serverTimestamp(), approvalId: approvalRef.id };
      if (isOwner) {
        applyRefund(tx, b, sale, session, caller, refund);
      } else {
        tx.update(saleRef, { status: 'refundPending', refund });
        notify(tx, b, settings, {
          type: 'refundRequest',
          severity: sale.totalCents >= settings.thresholds.refundAlertCents ? 'critical' : 'warning',
          title: `Refund requested: ${formatZar(sale.totalCents)}`,
          message: `${caller.name} asked to refund receipt #${sale.receiptNo}: ${reason}`,
          details: [
            { label: 'Receipt', value: `#${sale.receiptNo}` },
            { label: 'Originally sold', value: `${localTime((sale.soldAt ?? sale.createdAt).toDate(), settings)} by ${sale.employeeName}` },
            { label: 'Items', value: itemsText(sale.lines) },
            { label: 'Refund amount', value: formatZar(sale.totalCents), tone: 'bad' },
            { label: 'Paid by', value: sale.payment.method.toUpperCase() },
            { label: 'Reason given', value: reason },
            { label: 'Requested', value: localTime(new Date(), settings) },
          ],
          actorName: caller.name,
          action: sale.payment.method === 'cash'
            ? 'Approve or reject in Approvals. If approved, the cash comes out of the till that is open now.'
            : 'Approve or reject in Approvals. Card/EFT refunds must also be done on the card machine or by bank transfer.',
          link: '/approvals',
        });
      }
      audit(tx, b, caller, isOwner ? 'refund.applied' : 'refund.requested', 'sales', sale.id, { amountCents: sale.totalCents, reason });
      return { approvalId: approvalRef.id };
    });
  }),
);

/** Owner marks a card/EFT sale as matched to the terminal slip or bank statement. */
export const verifyPayment = onCall<ApiRequest<'verifyPayment'>, Promise<ApiResponse<'verifyPayment'>>>((req) =>
  handle(async () => {
    const owner = await requireCaller(req, ['owner']);
    const ref = col(owner.businessId, 'sales').doc(String(req.data.saleId));
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) fail('not-found', 'Sale not found');
      const sale = snap.data() as Sale;
      if (sale.payment.method === 'cash') fail('failed-precondition', 'Cash sales are reconciled through the cash count');
      const verified = !!req.data.verified;
      tx.update(ref, {
        'payment.verified': verified,
        'payment.verifiedBy': owner.uid,
        'payment.verifiedAt': FieldValue.serverTimestamp(),
      });
      audit(tx, owner.businessId, owner, verified ? 'payment.verified' : 'payment.unverified', 'sales', sale.id, { method: sale.payment.method, totalCents: sale.totalCents });
    });
    return { ok: true };
  }),
);
