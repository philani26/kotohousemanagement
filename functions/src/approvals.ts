import { onCall } from 'firebase-functions/v2/https';
import { ApiRequest, ApiResponse } from './shared/api';
import { Approval, CashSession, Expense, Ingredient, Sale } from './shared/models';
import { FieldValue, audit, col, db, fail, handle, optionalText, readSettings, requireCaller, todayKey } from './common';
import { applyExpenseDecision, applyRefund, applyStockChange, bumpStats, inc } from './effects';

/**
 * The owner approves or rejects a pending request. The effect of an approval
 * (refund paid, expense counted, stock adjusted) is applied here, in the same
 * transaction, so an approval can never be recorded without its effect.
 */
export const decideApproval = onCall<ApiRequest<'decideApproval'>, Promise<ApiResponse<'decideApproval'>>>((req) =>
  handle(async () => {
    const owner = await requireCaller(req, ['owner']);
    const b = owner.businessId;
    const approve = req.data.approve === true;
    const note = optionalText(req.data.note, 'Note', 300);
    if (!approve && !note) fail('invalid-argument', 'Give a reason for rejecting');

    await db.runTransaction(async (tx) => {
      const ref = col(b, 'approvals').doc(String(req.data.approvalId));
      const snap = await tx.get(ref);
      if (!snap.exists) fail('not-found', 'Approval not found');
      const approval = snap.data() as Approval;
      if (approval.status !== 'pending') fail('failed-precondition', 'This request has already been decided');
      const settings = await readSettings(b, tx);

      // ---- reads per type, then writes ----
      if (approval.type === 'refund') {
        const saleRef = col(b, 'sales').doc(approval.refId);
        const sale = (await tx.get(saleRef)).data() as Sale | undefined;
        if (!sale) fail('not-found', 'Sale not found');
        let session: CashSession | null = null;
        if (approve && sale.payment.method === 'cash') {
          const open = await tx.get(col(b, 'cashSessions').where('status', '==', 'open').limit(1));
          if (open.empty) fail('failed-precondition', 'Approve cash refunds while a shift is open, so the cash paid back is counted in the till');
          session = open.docs[0].data() as CashSession;
        }
        if (approve) applyRefund(tx, b, sale, session, owner);
        else tx.update(saleRef, { status: 'completed', 'refund.decidedBy': owner.uid, 'refund.decidedAt': FieldValue.serverTimestamp(), 'refund.rejected': true });
      } else if (approval.type === 'expense') {
        const expense = (await tx.get(col(b, 'expenses').doc(approval.refId))).data() as Expense | undefined;
        if (!expense) fail('not-found', 'Expense not found');
        const session = expense.shiftId ? ((await tx.get(col(b, 'cashSessions').doc(expense.shiftId))).data() as CashSession) : null;
        applyExpenseDecision(tx, b, expense, session, approve, owner, note);
      } else if (approval.type === 'stockAdjustment') {
        const ingSnap = await tx.get(col(b, 'ingredients').doc(approval.refId));
        if (!ingSnap.exists) fail('not-found', 'Ingredient not found');
        if (approve) {
          const ingredient = { ...(ingSnap.data() as Ingredient), id: ingSnap.id };
          const qtyChange = Number(approval.payload['qtyChange']);
          const value = applyStockChange(tx, b, owner, settings, {
            ingredient,
            qtyChange,
            type: 'adjustment',
            reason: `${approval.payload['reason']} (approved)`,
            refType: 'approval',
            refId: approval.id,
            shiftId: (approval.payload['shiftId'] as string | null) ?? null,
          });
          bumpStats(tx, b, todayKey(settings), { stockAdjustmentCents: inc(Math.sign(qtyChange) * value) });
        }
      }

      tx.update(ref, {
        status: approve ? 'approved' : 'rejected',
        decidedBy: owner.uid,
        decidedByName: owner.name,
        decidedAt: FieldValue.serverTimestamp(),
        ...(note ? { note } : {}),
      });
      audit(tx, b, owner, `approval.${approve ? 'approved' : 'rejected'}`, 'approvals', approval.id, {
        type: approval.type,
        refId: approval.refId,
        amountCents: approval.amountCents,
        note,
      });
    });
    return { ok: true };
  }),
);
