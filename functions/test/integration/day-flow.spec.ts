/**
 * End-to-end test of a full trading day against the emulators, calling the
 * real Cloud Functions through the client SDK exactly as the app does.
 *   cd functions && npm run test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FirebaseApp, deleteApp, initializeApp } from 'firebase/app';
import { Auth, connectAuthEmulator, createUserWithEmailAndPassword, getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import {
  Firestore,
  collection,
  connectFirestoreEmulator,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';
import { Functions, connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import type { ApiName, ApiRequest, ApiResponse } from '../../src/shared/api';
import type { CashSession, DailyStats, Ingredient, Sale } from '../../src/shared/models';

const PROJECT = 'demo-kotahouse';
// Ports come from firebase.test.json so tests can run alongside the dev emulators.
const AUTH = process.env['FIREBASE_AUTH_EMULATOR_HOST'] ?? '127.0.0.1:19099';
const [FS_HOST, FS_PORT] = (process.env['FIRESTORE_EMULATOR_HOST'] ?? '127.0.0.1:18080').split(':');
const FUNCTIONS_PORT = 15001;
const REGION = 'africa-south1';

interface Client {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  fns: Functions;
  call<K extends ApiName>(name: K, data: ApiRequest<K>): Promise<ApiResponse<K>>;
}

function client(name: string): Client {
  const app = initializeApp({ apiKey: 'demo-key', projectId: PROJECT, authDomain: `${PROJECT}.firebaseapp.com` }, name);
  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://${AUTH}`, { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, FS_HOST, Number(FS_PORT));
  const fns = getFunctions(app, REGION);
  connectFunctionsEmulator(fns, '127.0.0.1', FUNCTIONS_PORT);
  return {
    app,
    auth,
    db,
    fns,
    call: async (n, data) => (await httpsCallable(fns, n)(data)).data as never,
  };
}

const stamp = (uid: string) => ({ updatedBy: uid, updatedAt: serverTimestamp() });
const run = Date.now().toString(36);

let owner: Client;
let cashier: Client;
let b: string;
let ownerUid: string;
const ids = { basic: '', russian: '', bread: '', chips: '', russianSausage: '' };
const bpath = (...s: string[]) => ['businesses', b, ...s].join('/');

beforeAll(async () => {
  owner = client('owner');
  cashier = client('cashier');

  const cred = await createUserWithEmailAndPassword(owner.auth, `owner-${run}@example.co.za`, 'owner-pass-123');
  ownerUid = cred.user.uid;
  b = (await owner.call('setupBusiness', { businessName: 'Test Kota', displayName: 'Thandi' })).businessId;
  await cred.user.getIdToken(true);

  // Catalogue: written directly by the owner, as the app does
  for (const [key, name, unit, cost, qty] of [
    ['bread', 'Bread', 'each', 450, 20],
    ['chips', 'Chips', 'kg', 2000, 5],
    ['russianSausage', 'Russian', 'each', 900, 3],
  ] as const) {
    const ref = doc(collection(owner.db, bpath('ingredients')));
    ids[key] = ref.id;
    await setDoc(ref, { id: ref.id, name, unit, unitCostCents: cost, openingQty: qty, currentQty: qty, reorderLevel: 2, active: true, ...stamp(ownerUid) });
  }
  for (const [key, name, price, recipe] of [
    ['basic', 'Basic Kota', 3500, [[ids.bread, 1], [ids.chips, 0.15]]],
    ['russian', 'Russian Kota', 5500, [[ids.bread, 1], [ids.chips, 0.15], [ids.russianSausage, 1]]],
  ] as const) {
    const ref = doc(collection(owner.db, bpath('products')));
    ids[key] = ref.id;
    await setDoc(ref, { id: ref.id, name, category: 'kota', priceCents: price, active: true, sortOrder: 1, ...stamp(ownerUid) });
    await setDoc(doc(owner.db, bpath('recipes', ref.id)), {
      productId: ref.id,
      lines: recipe.map(([ingredientId, quantity]) => ({ ingredientId, quantity })),
      ...stamp(ownerUid),
    });
  }

  await owner.call('createEmployee', { email: `cashier-${run}@example.co.za`, password: 'cashier-pass-123', displayName: 'Sipho', role: 'employee' });
  await signInWithEmailAndPassword(cashier.auth, `cashier-${run}@example.co.za`, 'cashier-pass-123');
});

afterAll(async () => {
  await Promise.all([owner, cashier].filter(Boolean).map((c) => deleteApp(c.app)));
});

async function session(): Promise<CashSession> {
  const s = await getDocs(query(collection(owner.db, bpath('cashSessions')), where('status', '==', 'open')));
  return s.docs[0].data() as CashSession;
}
async function ingredient(id: string): Promise<Ingredient> {
  return (await getDoc(doc(owner.db, bpath('ingredients', id)))).data() as Ingredient;
}

describe('a trading day', () => {
  let shiftId = '';
  let firstSaleId = '';

  it('refuses sales before the shift is opened', async () => {
    await expect(
      cashier.call('recordSale', { saleId: `nosale${run}xxxxxxxxxx`, items: [{ productId: ids.basic, quantity: 1 }], payment: { method: 'card' } }),
    ).rejects.toThrow(/Open a shift/);
  });

  it('opens a shift with a float, and only one at a time', async () => {
    shiftId = (await cashier.call('openShift', { openingFloatCents: 50000, checklist: [] })).shiftId;
    await expect(owner.call('openShift', { openingFloatCents: 0, checklist: [] })).rejects.toThrow(/still open/);
  });

  it('prices on the server, gives change and deducts recipe stock', async () => {
    firstSaleId = `sale1${run}abcdefghij`;
    const res = await cashier.call('recordSale', {
      saleId: firstSaleId,
      items: [{ productId: ids.basic, quantity: 2 }, { productId: ids.russian, quantity: 1 }],
      payment: { method: 'cash', amountReceivedCents: 20000 },
    });
    expect(res.totalCents).toBe(3500 * 2 + 5500);
    expect(res.changeCents).toBe(20000 - 12500);
    expect(res.duplicate).toBe(false);

    expect((await ingredient(ids.bread)).currentQty).toBe(17);
    expect((await ingredient(ids.chips)).currentQty).toBeCloseTo(4.55, 3);
    expect((await ingredient(ids.russianSausage)).currentQty).toBe(2);
  });

  it('never records a retried sale twice', async () => {
    const again = await cashier.call('recordSale', {
      saleId: firstSaleId,
      items: [{ productId: ids.basic, quantity: 2 }, { productId: ids.russian, quantity: 1 }],
      payment: { method: 'cash', amountReceivedCents: 20000 },
    });
    expect(again.duplicate).toBe(true);
    expect((await session()).cashSalesCents).toBe(12500);
    expect((await ingredient(ids.bread)).currentQty).toBe(17);
  });

  it('rejects short cash and cashier discounts above the limit', async () => {
    await expect(
      cashier.call('recordSale', { saleId: `short${run}abcdefghij`, items: [{ productId: ids.basic, quantity: 1 }], payment: { method: 'cash', amountReceivedCents: 1000 } }),
    ).rejects.toThrow(/at least the order total/);
    await expect(
      cashier.call('recordSale', {
        saleId: `disc${run}abcdefghijk`,
        items: [{ productId: ids.basic, quantity: 1 }],
        discountCents: 500,
        discountReason: 'friend',
        payment: { method: 'card' },
      }),
    ).rejects.toThrow(/need the owner/);
  });

  it('records card and EFT sales separately from cash', async () => {
    await cashier.call('recordSale', { saleId: `card${run}abcdefghijk`, items: [{ productId: ids.basic, quantity: 1 }], payment: { method: 'card' } });
    await cashier.call('recordSale', { saleId: `eft${run}abcdefghijkl`, items: [{ productId: ids.basic, quantity: 1 }], payment: { method: 'eft', reference: 'INV1' } });
    const s = await session();
    expect(s.cardSalesCents).toBe(3500);
    expect(s.eftSalesCents).toBe(3500);
    expect(s.cashSalesCents).toBe(12500);
  });

  it('cashier refunds need owner approval; cash refunds leave the till', async () => {
    const saleId = `refund${run}abcdefghi`;
    await cashier.call('recordSale', { saleId, items: [{ productId: ids.basic, quantity: 1 }], payment: { method: 'cash', amountReceivedCents: 3500 } });
    const { approvalId } = await cashier.call('requestRefund', { saleId, reason: 'Wrong order' });
    expect(((await getDoc(doc(owner.db, bpath('sales', saleId)))).data() as Sale).status).toBe('refundPending');
    expect((await session()).cashRefundsCents).toBe(0);

    await expect(cashier.call('decideApproval', { approvalId, approve: true })).rejects.toThrow(/not allowed/);
    await owner.call('decideApproval', { approvalId, approve: true });
    expect(((await getDoc(doc(owner.db, bpath('sales', saleId)))).data() as Sale).status).toBe('refunded');
    expect((await session()).cashRefundsCents).toBe(3500);
  });

  it('only approved till expenses reduce expected cash', async () => {
    await cashier.call('submitExpense', { amountCents: 4000, category: 'Gas', description: 'Gas refill', date: '2026-01-01', paidFromTill: true });
    const pending = await getDocs(query(collection(owner.db, bpath('approvals')), where('status', '==', 'pending'), where('type', '==', 'expense')));
    expect((await session()).pendingCashExpensesCents).toBe(4000);
    expect((await session()).approvedCashExpensesCents).toBe(0);
    await owner.call('decideApproval', { approvalId: pending.docs[0].id, approve: true });
    const s = await session();
    expect(s.pendingCashExpensesCents).toBe(0);
    expect(s.approvedCashExpensesCents).toBe(4000);
  });

  it('lets a cashier add stock on top without a cost, leaving the cost unchanged', async () => {
    const before = await ingredient(ids.chips);
    await cashier.call('recordPurchase', { lines: [{ ingredientId: ids.chips, quantity: 2 }], paidFromTillCents: 0 });
    const after = await ingredient(ids.chips);
    expect(after.currentQty).toBeCloseTo(before.currentQty + 2, 3);
    expect(after.unitCostCents).toBe(before.unitCostCents);
    // and give it back so the rest of the day's numbers stay as planned
    await owner.call('recordStockMovement', { ingredientId: ids.chips, type: 'adjustment', quantity: -2, reason: 'Test undo' });
  });

  it('records deliveries paid from the till, wastage and payouts', async () => {
    await cashier.call('recordPurchase', { lines: [{ ingredientId: ids.bread, quantity: 10, unitCostCents: 500 }], paidFromTillCents: 5000 });
    expect((await ingredient(ids.bread)).currentQty).toBe(17 - 1 - 1 - 1 + 10); // 3 more single kotas sold above
    await cashier.call('recordStockMovement', { ingredientId: ids.chips, type: 'wastage', quantity: 0.5, reason: 'Burnt batch' });
    await cashier.call('recordPayout', { amountCents: 10000, reason: 'Cash drop to owner' });
    expect((await session()).cashPayoutsCents).toBe(15000);

    // employees cannot move stock with a direct adjustment – it becomes an approval
    const res = await cashier.call('recordStockMovement', { ingredientId: ids.bread, type: 'adjustment', quantity: 5, reason: 'Found extra' });
    expect(res.approvalId).toBeTruthy();
  });

  it('records queued offline sales at the time they happened and flags price changes', async () => {
    const soldAtMillis = Date.now() - 30 * 60_000;
    const saleId = `offline${run}abcdefgh`;
    const res = await cashier.call('recordSale', {
      saleId,
      items: [{ productId: ids.basic, quantity: 1 }],
      payment: { method: 'card' },
      soldAtMillis,
      expectedTotalCents: 3000, // charged an old price while offline
    });
    expect(res.totalCents).toBe(3500);
    const sale = (await getDoc(doc(owner.db, bpath('sales', saleId)))).data() as Sale;
    expect(sale.offline).toBe(true);
    expect(sale.soldAt!.toMillis()).toBe(soldAtMillis);
    const alerts = await getDocs(query(collection(owner.db, bpath('notifications')), where('type', '==', 'priceMismatch')));
    expect(alerts.size).toBe(1);

    await expect(
      cashier.call('recordSale', { saleId: `stale${run}abcdefghij`, items: [{ productId: ids.basic, quantity: 1 }], payment: { method: 'card' }, soldAtMillis: Date.now() - 48 * 3600_000 }),
    ).rejects.toThrow(/older than 24 hours/);
  });

  it('will not close until high-risk items are counted', async () => {
    await setDoc(doc(owner.db, bpath('ingredients', ids.russianSausage)), { countDaily: true, ...stamp(ownerUid) }, { merge: true });
    await expect(cashier.call('closeShift', { shiftId, countedCashCents: 43500, checklist: [], stockCounts: [] })).rejects.toThrow(
      /Count these items before closing: Russian/,
    );
  });

  it('closes with a blind count: differences need an explanation', async () => {
    // expected = 50000 float + 16000 cash sales − 3500 refund − 4000 expense − 15000 paid out = 43500
    await expect(
      cashier.call('closeShift', { shiftId, countedCashCents: 43000, checklist: [], stockCounts: [{ ingredientId: ids.russianSausage, countedQty: 1 }] }),
    ).rejects.toThrow(/Explain the cash difference/);

    const res = await cashier.call('closeShift', {
      shiftId,
      countedCashCents: 43000,
      cardTerminalTotalCents: 7000,
      explanation: 'Gave R5 too much change',
      checklist: [],
      stockCounts: [{ ingredientId: ids.russianSausage, countedQty: 1 }],
    });
    expect(res.expectedCashCents).toBe(43500);
    expect(res.differenceCents).toBe(-500);
    expect(res.cardDifferenceCents).toBe(0);
    expect(res.stockVariances).toHaveLength(1);
    expect(res.stockVariances[0].varianceQty).toBe(-1);

    const closed = (await getDoc(doc(owner.db, bpath('cashSessions', shiftId)))).data() as CashSession;
    expect(closed.status).toBe('closed');
    expect(closed.differenceCents).toBe(-500);
  });

  it('keeps daily stats that separate revenue from profit', async () => {
    const days = await getDocs(collection(owner.db, bpath('dailyStats')));
    const stats = days.docs.map((d) => d.data() as DailyStats);
    const sales = stats.reduce((s, d) => s + (d.grossSalesCents ?? 0), 0);
    const refunds = stats.reduce((s, d) => s + (d.refundsCents ?? 0), 0);
    expect(sales).toBe(12500 + 3500 * 4);
    expect(refunds).toBe(3500);
    expect(stats.reduce((s, d) => s + (d.orders ?? 0), 0)).toBe(5);
    expect(stats.reduce((s, d) => s + (d.cogsCents ?? 0), 0)).toBeGreaterThan(0);
    expect(stats.reduce((s, d) => s + (d.wastageCostCents ?? 0), 0)).toBe(1000);
    expect(stats.reduce((s, d) => s + (d.operatingExpensesCents ?? 0), 0)).toBe(4000);
  });

  it('writes an audit trail and owner notifications', async () => {
    const logs = await getDocs(collection(owner.db, bpath('auditLogs')));
    const actions = logs.docs.map((d) => d.get('action') as string);
    for (const a of ['business.created', 'employee.created', 'shift.opened', 'sale.recorded', 'refund.requested', 'approval.approved', 'expense.submitted', 'stock.purchase', 'stock.wastage', 'cash.payout', 'shift.closed']) {
      expect(actions).toContain(a);
    }
    const notes = await getDocs(collection(owner.db, bpath('notifications')));
    const types = notes.docs.map((d) => d.get('type') as string);
    expect(types).toEqual(expect.arrayContaining(['refundRequest', 'pendingExpense', 'shiftClosed', 'tillPurchase']));

    // alerts carry the full picture, e.g. the cash-up breakdown line by line
    const closed = notes.docs.map((d) => d.data()).find((n) => n['type'] === 'shiftClosed')!;
    const detail = (label: string) => (closed['details'] as { label: string; value: string }[]).find((d) => d.label === label)?.value;
    expect(closed['actorName']).toBe('Sipho');
    expect(detail('Opening float')).toMatch(/500,00/);
    expect(detail('= Expected in till')).toMatch(/435,00/);
    expect(detail('Counted')).toMatch(/430,00/);
    expect(detail('Explanation given')).toBe('Gave R5 too much change');
    const refund = notes.docs.map((d) => d.data()).find((n) => n['type'] === 'refundRequest')!;
    expect(refund['action']).toMatch(/Approvals/);
    expect((refund['details'] as { label: string }[]).map((d) => d.label)).toEqual(expect.arrayContaining(['Receipt', 'Items', 'Refund amount', 'Reason given']));
  });

  let b2 = '';
  it('lets the owner open another, fully separate shop', async () => {
    ({ businessId: b2 } = await owner.call('setupBusiness', { businessName: 'Test Kota Branch 2', displayName: 'Thandi' }));
    expect(b2).not.toBe(b);
    await owner.auth.currentUser!.getIdToken(true);

    // works in the new shop by passing its id, and the old shop keeps working
    const inB2 = { businessId: b2 } as Record<string, unknown>;
    const opened = await owner.call('openShift', { openingFloatCents: 10000, checklist: [], ...inB2 } as never);
    expect(opened.shiftId).toBeTruthy();
    const s2 = (await getDoc(doc(owner.db, 'businesses', b2, 'cashSessions', opened.shiftId))).data() as CashSession;
    expect(s2.openingFloatCents).toBe(10000);
    expect((await getDoc(doc(owner.db, bpath('cashSessions', shiftId)))).exists()).toBe(true);

    // shop 1's cashier has no access to shop 2
    await expect(cashier.call('recordPayout', { amountCents: 100, reason: 'test', ...inB2 } as never)).rejects.toThrow(/not linked to this shop/);
    await expect(getDoc(doc(cashier.db, 'businesses', b2, 'products', 'x'))).rejects.toThrow();
  });

  it('never lets stock go below zero, and alerts when an item runs out', async () => {
    const inB2 = { businessId: b2 } as Record<string, unknown>;
    const ing = doc(collection(owner.db, 'businesses', b2, 'ingredients'));
    await setDoc(ing, { id: ing.id, name: 'Russian', unit: 'each', unitCostCents: 900, openingQty: 1, currentQty: 1, reorderLevel: 2, active: true, ...stamp(ownerUid) });
    const prod = doc(collection(owner.db, 'businesses', b2, 'products'));
    await setDoc(prod, { id: prod.id, name: 'Russian Kota', category: 'kota', priceCents: 5000, active: true, sortOrder: 1, ...stamp(ownerUid) });
    await setDoc(doc(owner.db, 'businesses', b2, 'recipes', prod.id), { productId: prod.id, lines: [{ ingredientId: ing.id, quantity: 1 }], ...stamp(ownerUid) });

    // sells 2 with only 1 in stock: the sale goes through, stock stops at 0
    await owner.call('recordSale', { saleId: `neg${run}abcdefghijkl`, items: [{ productId: prod.id, quantity: 2 }], payment: { method: 'card' }, ...inB2 } as never);
    const after = (await getDoc(ing)).data() as Ingredient;
    expect(after.currentQty).toBe(0);
    expect(Object.is(after.currentQty, -0)).toBe(false);

    const moves = await getDocs(query(collection(owner.db, 'businesses', b2, 'stockMovements'), where('ingredientId', '==', ing.id), where('type', '==', 'sale')));
    expect(moves.docs[0].get('qtyChange')).toBe(-1);
    expect(moves.docs[0].get('shortfallQty')).toBe(1);

    const alerts = await getDocs(query(collection(owner.db, 'businesses', b2, 'notifications'), where('type', '==', 'outOfStock')));
    expect(alerts.size).toBe(1);
    expect(alerts.docs[0].get('severity')).toBe('critical');
    expect(alerts.docs[0].get('title')).toBe('Out of stock: Russian');

    // manual removals can't take what isn't there
    await expect(
      owner.call('recordStockMovement', { ingredientId: ing.id, type: 'wastage', quantity: 1, reason: 'dropped', ...inB2 } as never),
    ).rejects.toThrow(/Only 0 each of Russian in stock/);
  });

  it('only owners can add shops', async () => {
    await expect(cashier.call('setupBusiness', { businessName: 'My own', displayName: 'Sipho' })).rejects.toThrow(/Only a shop owner/);
  });

  it('prevents a deactivated cashier from trading', async () => {
    const emp = await getDocs(query(collection(owner.db, bpath('employees')), where('role', '==', 'employee')));
    await owner.call('updateEmployee', { uid: emp.docs[0].id, active: false });
    await expect(cashier.call('openShift', { openingFloatCents: 100, checklist: [] })).rejects.toThrow();
  });
});
