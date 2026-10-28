import { onCall } from 'firebase-functions/v2/https';
import { ApiRequest, ApiResponse } from './shared/api';
import { DomainError, reconcileCash, requireText, stockCountLine } from './shared/domain';
import { assertCents, formatZar } from './shared/money';
import { CashPayout, CashSession, ChecklistAnswer, Ingredient, Shift, StockCountLine } from './shared/models';
import { FieldValue, audit, col, db, fail, findOpenShift, handle, localTime, notify, optionalText, readSettings, requireCaller, todayKey } from './common';
import { applyStockChange, bumpStats } from './effects';

function cleanChecklist(input: unknown, allowed: string[]): ChecklistAnswer[] {
  const answers = Array.isArray(input) ? (input as ChecklistAnswer[]) : [];
  return allowed.map((item) => ({ item, done: answers.some((a) => a?.item === item && a.done === true) }));
}

/**
 * Opens the day. The shop has a single till, so only one shift may be open
 * at a time. The cash session shares the shift's id.
 */
export const openShift = onCall<ApiRequest<'openShift'>, Promise<ApiResponse<'openShift'>>>((req) =>
  handle(async () => {
    const caller = await requireCaller(req);
    const openingFloatCents = assertCents(req.data.openingFloatCents, 'Opening float', { max: 1_000_000 });
    const b = caller.businessId;

    return db.runTransaction(async (tx) => {
      const open = await tx.get(col(b, 'shifts').where('status', '==', 'open').limit(1));
      if (!open.empty) {
        const s = open.docs[0].data() as Shift;
        fail('failed-precondition', `${s.employeeName}'s shift is still open – close it first`);
      }
      const settings = await readSettings(b, tx);
      const ref = col(b, 'shifts').doc();
      const dayKey = todayKey(settings);
      const base = { employeeId: caller.uid, employeeName: caller.name, status: 'open', dayKey, openedAt: FieldValue.serverTimestamp() };
      tx.set(ref, {
        ...base,
        id: ref.id,
        cashSessionId: ref.id,
        openingChecklist: cleanChecklist(req.data.checklist, settings.openingChecklist),
      });
      tx.set(col(b, 'cashSessions').doc(ref.id), {
        ...base,
        id: ref.id,
        shiftId: ref.id,
        openingFloatCents,
        cashSalesCents: 0,
        cashRefundsCents: 0,
        approvedCashExpensesCents: 0,
        pendingCashExpensesCents: 0,
        cashPayoutsCents: 0,
        payouts: [],
        cardSalesCents: 0,
        eftSalesCents: 0,
      });
      audit(tx, b, caller, 'shift.opened', 'shifts', ref.id, { openingFloatCents });
      return { shiftId: ref.id };
    });
  }),
);

/** Cash taken out of the till for a reason other than an expense (e.g. a cash drop to the owner). */
export const recordPayout = onCall<ApiRequest<'recordPayout'>, Promise<ApiResponse<'recordPayout'>>>((req) =>
  handle(async () => {
    const caller = await requireCaller(req);
    const amountCents = assertCents(req.data.amountCents, 'Amount', { min: 1 });
    const reason = requireText(req.data.reason, 'Reason', 3, 200);
    const b = caller.businessId;

    await db.runTransaction(async (tx) => {
      const shift = await findOpenShift(tx, caller);
      if (!shift) fail('failed-precondition', 'No open shift');
      const settings = await readSettings(b, tx);
      const payout: CashPayout = { amountCents, reason, by: caller.uid, byName: caller.name, at: Date.now() };
      tx.update(col(b, 'cashSessions').doc(shift.cashSessionId), {
        cashPayoutsCents: FieldValue.increment(amountCents),
        payouts: FieldValue.arrayUnion(payout),
      });
      audit(tx, b, caller, 'cash.payout', 'cashSessions', shift.cashSessionId, { amountCents, reason });
      if (caller.role === 'employee') {
        notify(tx, b, settings, {
          type: 'cashPayout',
          severity: 'info',
          title: `Cash paid out: ${formatZar(amountCents)}`,
          message: `${caller.name}: ${reason}`,
          details: [
            { label: 'Amount taken out', value: formatZar(amountCents), tone: 'bad' },
            { label: 'Reason given', value: reason },
            { label: 'When', value: localTime(new Date(), settings) },
            { label: 'Shift', value: `${shift.employeeName}, opened ${localTime(shift.openedAt.toDate(), settings)}` },
          ],
          actorName: caller.name,
          action: 'This amount is subtracted from the expected cash at cash-up. Make sure you received it.',
          link: '/cash',
        });
      }
    });
    return { ok: true };
  }),
);

/**
 * Closes the shift with a blind cash count: the employee never sees the
 * expected amount before counting. Any difference must be explained, and the
 * expected balance itself can never be edited. Stock count variances become
 * stock adjustment approvals for the owner (applied directly if the owner closes).
 */
export const closeShift = onCall<ApiRequest<'closeShift'>, Promise<ApiResponse<'closeShift'>>>((req) =>
  handle(async () => {
    const caller = await requireCaller(req);
    const d = req.data;
    const countedCashCents = assertCents(d.countedCashCents, 'Counted cash', { max: 10_000_000 });
    const cardTerminalTotalCents =
      d.cardTerminalTotalCents === null || d.cardTerminalTotalCents === undefined
        ? null
        : assertCents(d.cardTerminalTotalCents, 'Card machine total', { max: 10_000_000 });
    const explanation = optionalText(d.explanation, 'Explanation', 500);
    const notes = optionalText(d.notes, 'Notes', 500);
    const counts = Array.isArray(d.stockCounts) ? d.stockCounts.slice(0, 200) : [];
    const b = caller.businessId;

    return db.runTransaction(async (tx) => {
      const shiftRef = col(b, 'shifts').doc(String(d.shiftId));
      const shiftSnap = await tx.get(shiftRef);
      if (!shiftSnap.exists) fail('not-found', 'Shift not found');
      const shift = shiftSnap.data() as Shift;
      if (shift.status !== 'open') fail('failed-precondition', 'This shift is already closed');
      if (caller.role === 'employee' && shift.employeeId !== caller.uid) fail('permission-denied', 'This is not your shift');

      const sessionRef = col(b, 'cashSessions').doc(shift.cashSessionId);
      const session = (await tx.get(sessionRef)).data() as CashSession;
      const settings = await readSettings(b, tx);
      const ingredientSnaps = counts.length ? await tx.getAll(...counts.map((c) => col(b, 'ingredients').doc(String(c.ingredientId)))) : [];
      const mustCount = await tx.get(col(b, 'ingredients').where('countDaily', '==', true).where('active', '==', true));

      const countedIds = new Set(counts.filter((c) => c.countedQty !== null && c.countedQty !== undefined && !Number.isNaN(Number(c.countedQty))).map((c) => String(c.ingredientId)));
      const missing = mustCount.docs.filter((doc) => !countedIds.has(doc.id)).map((doc) => doc.get('name') as string);
      if (missing.length) throw new DomainError(`Count these items before closing: ${missing.join(', ')}`);

      const cash = reconcileCash(session, countedCashCents, settings.thresholds.cashDiscrepancyCents);
      if (cash.requiresExplanation && (!explanation || explanation.length < 5)) {
        throw new DomainError('Explain the cash difference before closing');
      }
      const cardDifferenceCents = cardTerminalTotalCents === null ? null : cardTerminalTotalCents - session.cardSalesCents;

      const stockCounts: StockCountLine[] = [];
      const counted = new Map<string, Ingredient>();
      ingredientSnaps.forEach((snap, i) => {
        if (!snap.exists) return;
        const ingredient = { ...(snap.data() as Ingredient), id: snap.id };
        const line = stockCountLine(ingredient, Number(counts[i].countedQty));
        stockCounts.push(line);
        counted.set(snap.id, ingredient);
      });

      // ---- writes ----
      tx.update(shiftRef, {
        status: 'closed',
        closedAt: FieldValue.serverTimestamp(),
        closingChecklist: cleanChecklist(d.checklist, settings.closingChecklist),
        stockCounts,
        ...(notes ? { notes } : {}),
      });
      tx.update(sessionRef, {
        status: 'closed',
        closedAt: FieldValue.serverTimestamp(),
        expectedCashCents: cash.expectedCashCents,
        countedCashCents,
        differenceCents: cash.differenceCents,
        ...(explanation ? { explanation } : {}),
        cardTerminalTotalCents,
        cardDifferenceCents,
      });

      let varianceValue = 0;
      let adjustedValue = 0;
      for (const line of stockCounts.filter((l) => l.varianceQty !== 0)) {
        varianceValue += Math.abs(line.varianceCents);
        const reason = `Closing count variance (${line.theoreticalQty} expected, ${line.countedQty} counted)`;
        if (caller.role === 'owner') {
          adjustedValue += Math.sign(line.varianceQty) * applyStockChange(tx, b, caller, settings, {
            ingredient: counted.get(line.ingredientId)!,
            qtyChange: line.varianceQty,
            type: 'adjustment',
            reason,
            refType: 'ingredient',
            refId: shift.id,
            shiftId: shift.id,
          });
        } else {
          const ref = col(b, 'approvals').doc();
          tx.set(ref, {
            id: ref.id,
            type: 'stockAdjustment',
            status: 'pending',
            refId: line.ingredientId,
            summary: `${line.ingredientName}: ${line.varianceQty > 0 ? '+' : ''}${line.varianceQty} ${line.unit} – ${reason}`,
            amountCents: Math.abs(line.varianceCents),
            payload: { ingredientId: line.ingredientId, qtyChange: line.varianceQty, reason, shiftId: shift.id },
            requestedBy: caller.uid,
            requestedByName: caller.name,
            requestedAt: FieldValue.serverTimestamp(),
          });
        }
      }

      if (adjustedValue !== 0) bumpStats(tx, b, shift.dayKey, { stockAdjustmentCents: FieldValue.increment(adjustedValue) });

      const opened = localTime(shift.openedAt.toDate(), settings);
      const closedAt = localTime(new Date(), settings);
      const diffTone = cash.differenceCents < 0 ? 'bad' : cash.differenceCents > 0 ? 'warn' : 'good';
      /** how the expected cash was worked out, line by line */
      const cashBreakdown = [
        { label: 'Shift', value: `${shift.employeeName} · ${opened} → ${closedAt}` },
        { label: 'Opening float', value: formatZar(session.openingFloatCents) },
        { label: '+ Cash sales', value: formatZar(session.cashSalesCents) },
        { label: '− Cash refunds', value: formatZar(session.cashRefundsCents) },
        { label: '− Approved cash expenses', value: formatZar(session.approvedCashExpensesCents) },
        { label: '− Cash paid out', value: formatZar(session.cashPayoutsCents) },
        { label: '= Expected in till', value: formatZar(cash.expectedCashCents) },
        { label: 'Counted', value: formatZar(countedCashCents) },
        { label: 'Difference', value: `${cash.differenceCents > 0 ? '+' : ''}${formatZar(cash.differenceCents)}`, tone: diffTone as 'bad' | 'warn' | 'good' },
        ...(session.pendingCashExpensesCents
          ? [{ label: 'Till expenses still awaiting approval', value: formatZar(session.pendingCashExpensesCents), tone: 'warn' as const }]
          : []),
        ...(explanation ? [{ label: 'Explanation given', value: explanation }] : []),
      ];
      const diffText = cash.differenceCents === 0 ? 'Cash balanced' : `Cash ${cash.differenceCents < 0 ? 'short' : 'over'} by ${formatZar(Math.abs(cash.differenceCents))}`;
      notify(tx, b, settings, {
        type: 'shiftClosed',
        severity: 'info',
        title: `Shift closed by ${caller.name}`,
        message: `${diffText}. Expected ${formatZar(cash.expectedCashCents)}, counted ${formatZar(countedCashCents)}.`,
        details: [
          ...cashBreakdown,
          { label: 'Card sales', value: formatZar(session.cardSalesCents) },
          { label: 'EFT sales', value: formatZar(session.eftSalesCents) },
          { label: 'Stock items counted', value: `${stockCounts.length}${varianceValue ? ` · variance ${formatZar(varianceValue)}` : ''}` },
          ...(notes ? [{ label: 'Notes from cashier', value: notes }] : []),
        ],
        actorName: caller.name,
        link: '/cash',
      });
      if (cash.isAlert) {
        notify(tx, b, settings, {
          type: 'cashDiscrepancy',
          severity: 'critical',
          title: diffText,
          message: `${caller.name} closed with ${formatZar(countedCashCents)} against ${formatZar(cash.expectedCashCents)} expected. Explanation: ${explanation}`,
          details: cashBreakdown,
          actorName: caller.name,
          action: `Check the explanation, any pending till expenses, and the till camera around ${closedAt}. Compare with earlier cash-ups for a pattern.`,
          link: '/cash',
        });
      }
      if (cardDifferenceCents !== null && cardDifferenceCents !== 0) {
        notify(tx, b, settings, {
          type: 'cashDiscrepancy',
          severity: 'warning',
          title: `Card machine differs by ${formatZar(Math.abs(cardDifferenceCents))}`,
          message: `Card machine total ${formatZar(cardTerminalTotalCents!)} vs ${formatZar(session.cardSalesCents)} recorded card sales.`,
          details: [
            { label: 'Shift', value: `${shift.employeeName} · ${opened} → ${closedAt}` },
            { label: 'Card machine batch total', value: formatZar(cardTerminalTotalCents!) },
            { label: 'Card sales recorded in the app', value: formatZar(session.cardSalesCents) },
            {
              label: 'Difference',
              value: formatZar(cardDifferenceCents),
              tone: cardDifferenceCents < 0 ? 'bad' : 'warn',
            },
          ],
          actorName: caller.name,
          action: cardDifferenceCents > 0
            ? 'More was swiped than recorded: a sale may have been taken on the machine but not rung up in the app.'
            : 'Less was swiped than recorded: a card sale may have been rung up but paid another way. Check the Sales list.',
          link: '/cash',
        });
      }
      if (varianceValue > settings.thresholds.stockVarianceAlertCents) {
        notify(tx, b, settings, {
          type: 'stockVariance',
          severity: 'warning',
          title: `Stock count variance ${formatZar(varianceValue)}`,
          message: `${stockCounts.filter((l) => l.varianceQty !== 0).length} items did not match the expected stock at close.`,
          details: [
            { label: 'Shift', value: `${shift.employeeName} · closed ${closedAt}` },
            ...stockCounts
              .filter((l) => l.varianceQty !== 0)
              .sort((a, z) => Math.abs(z.varianceCents) - Math.abs(a.varianceCents))
              .map((l) => ({
                label: l.ingredientName,
                value: `expected ${l.theoreticalQty}, counted ${l.countedQty} ${l.unit} → ${l.varianceQty > 0 ? '+' : ''}${l.varianceQty} (${formatZar(l.varianceCents)})`,
                tone: (l.varianceQty < 0 ? 'bad' : 'warn') as 'bad' | 'warn',
              })),
            { label: 'Total variance at cost', value: formatZar(varianceValue), tone: 'bad' },
          ],
          actorName: caller.name,
          action: 'Approve or reject each correction in Approvals. Shortages of the same item day after day point to theft or unrecorded wastage.',
          link: '/approvals',
        });
      }
      audit(tx, b, caller, 'shift.closed', 'shifts', shift.id, {
        expectedCashCents: cash.expectedCashCents,
        countedCashCents,
        differenceCents: cash.differenceCents,
        explanation,
        cardDifferenceCents,
        stockVarianceCents: varianceValue,
      });

      return {
        expectedCashCents: cash.expectedCashCents,
        differenceCents: cash.differenceCents,
        cardDifferenceCents,
        stockVariances: stockCounts.filter((l) => l.varianceQty !== 0),
      };
    });
  }),
);
