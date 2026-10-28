import { onCall } from 'firebase-functions/v2/https';
import { ApiRequest, ApiResponse } from './shared/api';
import { DomainError, requireText } from './shared/domain';
import { assertCents, formatZar } from './shared/money';
import { CashSession, Expense } from './shared/models';
import { FieldValue, assertReceiptPath, audit, col, db, fail, findOpenShift, handle, localTime, notify, readSettings, requireCaller, todayKey } from './common';
import { bumpStats, expenseStatsField, inc } from './effects';

/**
 * Expenses are submitted for owner approval. Only approved cash expenses
 * reduce the expected till balance; pending ones are shown separately at close.
 * Expenses the owner records are approved immediately.
 */
export const submitExpense = onCall<ApiRequest<'submitExpense'>, Promise<ApiResponse<'submitExpense'>>>((req) =>
  handle(async () => {
    const caller = await requireCaller(req);
    const d = req.data;
    const b = caller.businessId;
    const amountCents = assertCents(d.amountCents, 'Amount', { min: 1 });
    const description = requireText(d.description, 'Description', 3, 300);
    const receiptPath = assertReceiptPath(d.receiptPath, caller);
    if (typeof d.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d.date)) throw new DomainError('Invalid expense date');

    return db.runTransaction(async (tx) => {
      const settings = await readSettings(b, tx);
      if (!settings.expenseCategories.includes(d.category)) throw new DomainError('Choose a valid expense category');
      if (d.date > todayKey(settings)) throw new DomainError('Expense date cannot be in the future');

      let session: CashSession | null = null;
      if (d.paidFromTill) {
        const shift = await findOpenShift(tx, caller);
        if (!shift) fail('failed-precondition', 'A shift must be open to pay an expense from the till');
        session = (await tx.get(col(b, 'cashSessions').doc(shift.cashSessionId))).data() as CashSession;
      }

      const expenseRef = col(b, 'expenses').doc();
      const approvalRef = col(b, 'approvals').doc();
      const isOwner = caller.role === 'owner';
      const expense: Omit<Expense, 'createdAt'> = {
        id: expenseRef.id,
        amountCents,
        category: d.category,
        description,
        date: d.date,
        paidFromTill: !!d.paidFromTill,
        ...(receiptPath ? { receiptPath } : {}),
        status: isOwner ? 'approved' : 'submitted',
        shiftId: session?.id ?? null,
        submittedBy: caller.uid,
        submittedByName: caller.name,
        approvalId: approvalRef.id,
      };
      tx.set(expenseRef, {
        ...expense,
        createdAt: FieldValue.serverTimestamp(),
        ...(isOwner ? { decision: { by: caller.uid, byName: caller.name, at: FieldValue.serverTimestamp(), note: 'Recorded by owner' } } : {}),
      });
      tx.set(approvalRef, {
        id: approvalRef.id,
        type: 'expense',
        status: isOwner ? 'approved' : 'pending',
        refId: expenseRef.id,
        summary: `${d.category}: ${description}${d.paidFromTill ? ' (paid from till)' : ''}`,
        amountCents,
        payload: { category: d.category, paidFromTill: !!d.paidFromTill, hasReceipt: !!receiptPath },
        requestedBy: caller.uid,
        requestedByName: caller.name,
        requestedAt: FieldValue.serverTimestamp(),
        ...(isOwner ? { decidedBy: caller.uid, decidedByName: caller.name, decidedAt: FieldValue.serverTimestamp() } : {}),
      });

      if (session) {
        const field = isOwner ? 'approvedCashExpensesCents' : 'pendingCashExpensesCents';
        tx.update(col(b, 'cashSessions').doc(session.id), { [field]: FieldValue.increment(amountCents) });
      }
      if (isOwner) {
        bumpStats(tx, b, d.date, { [expenseStatsField(d.category)]: inc(amountCents) });
      } else {
        notify(tx, b, settings, {
          type: 'pendingExpense',
          severity: 'warning',
          title: `Expense to approve: ${formatZar(amountCents)}`,
          message: `${caller.name} – ${d.category}: ${description}${d.paidFromTill ? ' (cash from till)' : ''}${receiptPath ? '' : ' – no receipt'}`,
          details: [
            { label: 'Amount', value: formatZar(amountCents) },
            { label: 'Category', value: d.category },
            { label: 'What for', value: description },
            { label: 'Date of expense', value: d.date },
            { label: 'Paid with', value: d.paidFromTill ? 'Cash from the till' : 'Not from the till' },
            { label: 'Receipt photo', value: receiptPath ? 'Attached – view it in Approvals' : 'None attached', tone: receiptPath ? 'good' : 'bad' },
            { label: 'Submitted', value: localTime(new Date(), settings) },
          ],
          actorName: caller.name,
          action: d.paidFromTill
            ? 'Approve or reject in Approvals. Until you approve, this cash is not subtracted from the expected till balance.'
            : 'Approve or reject in Approvals.',
          link: '/approvals',
        });
      }
      audit(tx, b, caller, 'expense.submitted', 'expenses', expenseRef.id, { amountCents, category: d.category, paidFromTill: !!d.paidFromTill });
      return { expenseId: expenseRef.id };
    });
  }),
);
