/**
 * Seeds the LOCAL EMULATORS with a demo shop, owner, cashier, menu and a few
 * sales so you can explore the app. Never run against production.
 *
 *   npm run emulators            (in one terminal)
 *   node functions/scripts/seed-demo.mjs
 *
 * Logins:  owner@demo.co.za / owner-pass-123   ·   cashier@demo.co.za / cashier-pass-123
 */
import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, createUserWithEmailAndPassword, getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { collection, connectFirestoreEmulator, doc, getFirestore, serverTimestamp, writeBatch } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';

const cfg = { apiKey: 'demo-key', projectId: 'demo-kotahouse', authDomain: 'demo-kotahouse.firebaseapp.com' };

function client(name) {
  const app = initializeApp(cfg, name);
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, '127.0.0.1', 8085);
  const fns = getFunctions(app, 'africa-south1');
  connectFunctionsEmulator(fns, '127.0.0.1', 5001);
  const call = async (n, data) => (await httpsCallable(fns, n)(data)).data;
  return { auth, db, call };
}

const owner = client('owner');
const cashier = client('cashier');

const cred = await createUserWithEmailAndPassword(owner.auth, 'owner@demo.co.za', 'owner-pass-123');
const { businessId } = await owner.call('setupBusiness', { businessName: 'Mzansi Kota House', displayName: 'Thandi' });
await cred.user.getIdToken(true);
const uid = cred.user.uid;
const stamp = { updatedBy: uid, updatedAt: serverTimestamp() };
const col = (n) => collection(owner.db, 'businesses', businessId, n);

const ingredients = [
  ['bread', 'Bread (quarter loaf)', 'each', 450, 20, 60],
  ['chips', 'Potatoes / chips', 'kg', 1800, 5, 20],
  ['polony', 'Polony slice', 'slice', 120, 30, 200],
  ['russian', 'Russian sausage', 'each', 900, 10, 14],
  ['cheese', 'Cheese slice', 'slice', 180, 20, 80],
  ['egg', 'Eggs', 'each', 250, 12, 30],
  ['atchar', 'Atchar', 'kg', 6000, 1, 3],
  ['oil', 'Cooking oil', 'litre', 3500, 5, 10],
  ['cooldrink', 'Cold drink 440ml', 'each', 900, 24, 30],
];
const ids = {};
let batch = writeBatch(owner.db);
for (const [key, name, unit, unitCostCents, reorderLevel, qty] of ingredients) {
  const ref = doc(col('ingredients'));
  ids[key] = ref.id;
  batch.set(ref, { id: ref.id, name, unit, unitCostCents, reorderLevel, openingQty: qty, currentQty: qty, active: true, ...stamp });
}
const sup = doc(col('suppliers'));
batch.set(sup, { id: sup.id, name: 'Soweto Bakery', phone: '0110000000', email: '', notes: 'Delivers 7am', active: true, ...stamp });

const products = [
  ['Basic Kota', 'kota', 3000, '#f2b33d', [['bread', 1], ['chips', 0.15], ['polony', 2], ['atchar', 0.02], ['oil', 0.03]]],
  ['Russian Kota', 'kota', 4500, '#c2410c', [['bread', 1], ['chips', 0.15], ['polony', 2], ['russian', 1], ['atchar', 0.02], ['oil', 0.04]]],
  ['Cheese Kota', 'kota', 4000, '#eab308', [['bread', 1], ['chips', 0.15], ['polony', 2], ['cheese', 2], ['oil', 0.03]]],
  ['Egg Kota', 'kota', 4000, '#fde68a', [['bread', 1], ['chips', 0.15], ['polony', 2], ['egg', 1], ['oil', 0.04]]],
  ['Special Kota', 'kota', 6000, '#7c2d12', [['bread', 1], ['chips', 0.2], ['polony', 2], ['russian', 1], ['cheese', 2], ['egg', 1], ['oil', 0.05]]],
  ['Chips (small)', 'sides', 2000, '#facc15', [['chips', 0.2], ['oil', 0.03]]],
  ['Cold drink', 'drinks', 1500, '#1d4ed8', [['cooldrink', 1]]],
  ['Extra cheese', 'extras', 600, '#a3a3a3', [['cheese', 1]]],
];
const pid = [];
products.forEach(([name, category, priceCents, colour, recipe], i) => {
  const ref = doc(col('products'));
  pid.push(ref.id);
  batch.set(ref, { id: ref.id, name, category, priceCents, colour, active: true, sortOrder: i + 1, ...stamp });
  batch.set(doc(col('recipes'), ref.id), { productId: ref.id, lines: recipe.map(([k, quantity]) => ({ ingredientId: ids[k], quantity })), ...stamp });
});
await batch.commit();

await owner.call('createEmployee', { email: 'cashier@demo.co.za', password: 'cashier-pass-123', displayName: 'Sipho', role: 'employee' });
await signInWithEmailAndPassword(cashier.auth, 'cashier@demo.co.za', 'cashier-pass-123');

await cashier.call('openShift', { openingFloatCents: 50000, checklist: [] });
const sale = (items, method, received) =>
  cashier.call('recordSale', {
    saleId: crypto.randomUUID().replace(/-/g, ''),
    items: items.map(([i, quantity]) => ({ productId: pid[i], quantity })),
    payment: { method, amountReceivedCents: received },
  });
await sale([[0, 2], [6, 2]], 'cash', 10000);
await sale([[1, 1]], 'card');
await sale([[4, 1], [6, 1]], 'cash', 10000);
await sale([[2, 1], [5, 1]], 'eft');
await sale([[1, 3]], 'cash', 15000);
await sale([[3, 1]], 'cash', 5000);
const refundMe = await sale([[0, 1]], 'cash', 3000);
await cashier.call('requestRefund', { saleId: refundMe.saleId, reason: 'Customer said polony was cold' });
await cashier.call('submitExpense', { amountCents: 32000, category: 'Gas', description: '9kg gas refill', date: new Date().toISOString().slice(0, 10), paidFromTill: true });
await cashier.call('recordStockMovement', { ingredientId: ids.chips, type: 'wastage', quantity: 0.6, reason: 'Burnt batch' });

console.log('Seeded business', businessId);
console.log('Owner:   owner@demo.co.za / owner-pass-123');
console.log('Cashier: cashier@demo.co.za / cashier-pass-123 (shift is open)');
process.exit(0);
