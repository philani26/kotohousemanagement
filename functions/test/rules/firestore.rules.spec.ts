/**
 * Security rule tests. Run with the emulator (needs Java 21+):
 *   cd functions && npm run test:rules
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  RulesTestEnvironment,
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, serverTimestamp, setDoc, updateDoc, deleteDoc, collection, getDocs, query, where } from 'firebase/firestore';

const B = 'biz1';
const OTHER = 'biz2';
let env: RulesTestEnvironment;

const owner = () => env.authenticatedContext('owner1', { businessId: B, role: 'owner' }).firestore();
const employee = () => env.authenticatedContext('emp1', { businessId: B, role: 'employee' }).firestore();
const otherOwner = () => env.authenticatedContext('owner2', { businessId: OTHER, role: 'owner' }).firestore();
const noClaims = () => env.authenticatedContext('stranger').firestore();
const p = (...segments: string[]) => ['businesses', B, ...segments].join('/');

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-kotahouse',
    firestore: { rules: readFileSync(resolve(__dirname, '../../../firestore.rules'), 'utf8') },
  });
});

afterAll(async () => env.cleanup());

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, `businesses/${B}`), { name: 'Kota One', ownerUid: 'owner1' });
    await setDoc(doc(db, p('products', 'basic')), { name: 'Basic Kota', priceCents: 3500, active: true, category: 'kota' });
    await setDoc(doc(db, p('ingredients', 'bread')), { name: 'Bread', currentQty: 10, openingQty: 10, unitCostCents: 450, reorderLevel: 2, unit: 'loaf' });
    await setDoc(doc(db, p('sales', 's-emp')), { employeeId: 'emp1', totalCents: 3500 });
    await setDoc(doc(db, p('sales', 's-other')), { employeeId: 'emp2', totalCents: 5500 });
    await setDoc(doc(db, p('cashSessions', 'c1')), { employeeId: 'emp1', openingFloatCents: 50000 });
    await setDoc(doc(db, p('auditLogs', 'a1')), { action: 'sale.recorded' });
    await setDoc(doc(db, p('notifications', 'n1')), { title: 'x', read: false });
    await setDoc(doc(db, p('employees', 'emp1')), { role: 'employee', active: true });
    await setDoc(doc(db, `users/emp1`), { role: 'employee', businessId: B });
  });
});

describe('multiple shops', () => {
  const multiOwner = () =>
    env.authenticatedContext('boss', { businessId: OTHER, role: 'owner', biz: { [OTHER]: 'owner', [B]: 'owner' } }).firestore();
  const branchCashier = () => env.authenticatedContext('emp9', { businessId: OTHER, role: 'employee', biz: { [OTHER]: 'employee' } }).firestore();

  it('an owner of several shops can work in each of them', async () => {
    await assertSucceeds(getDoc(doc(multiOwner(), p('cashSessions', 'c1'))));
    await assertSucceeds(updateDoc(doc(multiOwner(), p('products', 'basic')), { priceCents: 3900, updatedBy: 'boss', updatedAt: serverTimestamp() }));
  });

  it('staff of one branch cannot see another branch', async () => {
    await assertFails(getDoc(doc(branchCashier(), p('products', 'basic'))));
  });

  it('being staff in one shop never makes you owner of another', async () => {
    const mixed = env.authenticatedContext('emp1', { businessId: B, role: 'employee', biz: { [B]: 'employee', [OTHER]: 'owner' } }).firestore();
    await assertFails(getDoc(doc(mixed, p('cashSessions', 'c1'))));
  });
});

describe('tenancy', () => {
  it('blocks another business and users without claims', async () => {
    await assertFails(getDoc(doc(otherOwner(), p('products', 'basic'))));
    await assertFails(getDoc(doc(noClaims(), p('products', 'basic'))));
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), p('products', 'basic'))));
  });
});

describe('sales', () => {
  it('employees cannot create, edit or delete sales', async () => {
    await assertFails(setDoc(doc(employee(), p('sales', 'new')), { employeeId: 'emp1', totalCents: 1 }));
    await assertFails(updateDoc(doc(employee(), p('sales', 's-emp')), { totalCents: 0 }));
    await assertFails(deleteDoc(doc(employee(), p('sales', 's-emp'))));
  });

  it('owners cannot silently change history either', async () => {
    await assertFails(updateDoc(doc(owner(), p('sales', 's-emp')), { totalCents: 0 }));
    await assertFails(deleteDoc(doc(owner(), p('sales', 's-emp'))));
  });

  it('employees read only their own sales', async () => {
    await assertSucceeds(getDoc(doc(employee(), p('sales', 's-emp'))));
    await assertFails(getDoc(doc(employee(), p('sales', 's-other'))));
    await assertSucceeds(getDocs(query(collection(employee(), p('sales')), where('employeeId', '==', 'emp1'))));
    await assertFails(getDocs(collection(employee(), p('sales'))));
  });
});

describe('cash and audit', () => {
  it('employees cannot see expected cash (blind count)', async () => {
    await assertFails(getDoc(doc(employee(), p('cashSessions', 'c1'))));
    await assertSucceeds(getDoc(doc(owner(), p('cashSessions', 'c1'))));
  });

  it('audit logs are read-only for everyone', async () => {
    await assertFails(getDoc(doc(employee(), p('auditLogs', 'a1'))));
    await assertSucceeds(getDoc(doc(owner(), p('auditLogs', 'a1'))));
    await assertFails(updateDoc(doc(owner(), p('auditLogs', 'a1')), { action: 'x' }));
    await assertFails(deleteDoc(doc(owner(), p('auditLogs', 'a1'))));
  });

  it('owners can only mark notifications read', async () => {
    await assertSucceeds(updateDoc(doc(owner(), p('notifications', 'n1')), { read: true }));
    await assertFails(updateDoc(doc(owner(), p('notifications', 'n1')), { title: 'edited' }));
    await assertFails(updateDoc(doc(employee(), p('notifications', 'n1')), { read: true }));
  });
});

describe('roles', () => {
  it('employees cannot grant themselves owner privileges', async () => {
    await assertFails(updateDoc(doc(employee(), p('employees', 'emp1')), { role: 'owner' }));
    await assertFails(updateDoc(doc(employee(), 'users/emp1'), { role: 'owner' }));
    await assertFails(setDoc(doc(employee(), p('employees', 'emp9')), { role: 'owner' }));
  });
});

describe('orders (kitchen queue)', () => {
  const order = (uid: string) => ({
    id: 'o1', lines: [{ name: 'Russian Kota', quantity: 2 }], note: 'no atchar', status: 'new',
    createdAtMillis: 1700000000000, createdBy: uid, createdByName: 'Sipho', dayKey: '2026-10-25',
    updatedBy: uid, updatedAt: serverTimestamp(),
  });

  it('staff create tickets and move them through the queue', async () => {
    await assertSucceeds(setDoc(doc(employee(), p('orders', 'o1')), order('emp1')));
    await assertSucceeds(updateDoc(doc(employee(), p('orders', 'o1')), { status: 'preparing', preparingAt: 1, updatedBy: 'emp1', updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(doc(owner(), p('orders', 'o1')), { status: 'collected', collectedAt: 2, updatedBy: 'owner1', updatedAt: serverTimestamp() }));
  });

  it('items cannot be changed, tickets cannot be deleted or faked', async () => {
    await assertSucceeds(setDoc(doc(employee(), p('orders', 'o1')), order('emp1')));
    await assertFails(updateDoc(doc(employee(), p('orders', 'o1')), { lines: [], updatedBy: 'emp1', updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(employee(), p('orders', 'o1')), { status: 'eaten', updatedBy: 'emp1', updatedAt: serverTimestamp() }));
    await assertFails(deleteDoc(doc(employee(), p('orders', 'o1'))));
    await assertFails(setDoc(doc(employee(), p('orders', 'o2')), { ...order('owner1'), id: 'o2' }));
    await assertFails(setDoc(doc(employee(), p('orders', 'o3')), { ...order('emp1'), id: 'o3', status: 'collected' }));
    await assertFails(setDoc(doc(employee(), p('orders', 'o4')), { ...order('emp1'), id: 'o4', totalCents: 1 }));
    await assertFails(getDoc(doc(otherOwner(), p('orders', 'o1'))));
  });
});

describe('kitchen role', () => {
  const kitchen = () => env.authenticatedContext('chef1', { businessId: B, role: 'kitchen', biz: { [B]: 'kitchen' } }).firestore();
  const ticket = { id: 'k1', lines: [{ name: 'Russian Kota', quantity: 1 }], status: 'new', createdAtMillis: 1, createdBy: 'emp1', createdByName: 'Sipho', dayKey: '2026-10-31', updatedBy: 'emp1' };

  it('sees the order queue and moves tickets to preparing and ready', async () => {
    await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), p('orders', 'k1')), ticket));
    await assertSucceeds(getDoc(doc(kitchen(), p('orders', 'k1'))));
    await assertSucceeds(updateDoc(doc(kitchen(), p('orders', 'k1')), { status: 'preparing', preparingAt: 2, updatedBy: 'chef1', updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(doc(kitchen(), p('orders', 'k1')), { status: 'ready', readyAt: 3, updatedBy: 'chef1', updatedAt: serverTimestamp() }));
  });

  it('hands over paid orders, but never an unpaid WhatsApp order', async () => {
    await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), p('orders', 'k1')), { ...ticket, status: 'ready' }));
    await assertSucceeds(updateDoc(doc(kitchen(), p('orders', 'k1')), { status: 'collected', collectedAt: 4, updatedBy: 'chef1', updatedAt: serverTimestamp() }));

    await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), p('orders', 'w1')), { ...ticket, id: 'w1', status: 'ready', source: 'whatsapp', paid: false }));
    await assertFails(updateDoc(doc(kitchen(), p('orders', 'w1')), { status: 'collected', collectedAt: 4, updatedBy: 'chef1', updatedAt: serverTimestamp() }));
    await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), p('orders', 'w1')), { paid: true }));
    await assertSucceeds(updateDoc(doc(kitchen(), p('orders', 'w1')), { status: 'collected', collectedAt: 5, updatedBy: 'chef1', updatedAt: serverTimestamp() }));
  });

  it('cannot mark paid or create tickets', async () => {
    await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), p('orders', 'k1')), ticket));
    await assertFails(updateDoc(doc(kitchen(), p('orders', 'k1')), { paid: true, updatedBy: 'chef1', updatedAt: serverTimestamp() }));
    await assertFails(setDoc(doc(kitchen(), p('orders', 'k2')), { ...ticket, id: 'k2', createdBy: 'chef1', updatedBy: 'chef1', updatedAt: serverTimestamp() }));
  });

  it('sees no money, stock or sales', async () => {
    await assertFails(getDoc(doc(kitchen(), p('sales', 's-emp'))));
    await assertFails(getDoc(doc(kitchen(), p('cashSessions', 'c1'))));
    await assertFails(getDoc(doc(kitchen(), p('ingredients', 'bread'))));
    await assertFails(getDoc(doc(kitchen(), p('products', 'basic'))));
    await assertFails(getDoc(doc(kitchen(), p('auditLogs', 'a1'))));
  });
});

describe('work-site check (geofence)', () => {
  const kitchen = () => env.authenticatedContext('chef1', { businessId: B, role: 'kitchen', biz: { [B]: 'kitchen' } }).firestore();
  const ticket = { id: 'g1', lines: [{ name: 'Basic Kota', quantity: 1 }], status: 'new', createdAtMillis: 1, createdBy: 'emp1', createdByName: 'Sipho', dayKey: '2026-10-31', updatedBy: 'emp1' };
  const move = () => updateDoc(doc(kitchen(), p('orders', 'g1')), { status: 'preparing', preparingAt: 2, updatedBy: 'chef1', updatedAt: serverTimestamp() });

  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), p('orders', 'g1')), ticket);
      await setDoc(doc(ctx.firestore(), p('businessSettings', 'main')), { geofence: { enabled: true, lat: -26.2, lng: 27.8, radiusM: 150 } });
      await setDoc(doc(ctx.firestore(), p('employees', 'chef1')), { role: 'kitchen', active: true });
    });
  });

  it('blocks staff who have not checked in at the shop', async () => {
    await assertFails(move());
  });

  it('allows staff after a check-in, until it expires', async () => {
    await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), p('employees', 'chef1')), { siteCheckUntil: new Date(Date.now() + 3_600_000) }));
    await assertSucceeds(move());
    await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), p('employees', 'chef1')), { siteCheckUntil: new Date(Date.now() - 1000) }));
    await assertFails(updateDoc(doc(kitchen(), p('orders', 'g1')), { status: 'ready', readyAt: 3, updatedBy: 'chef1', updatedAt: serverTimestamp() }));
  });

  it('never blocks the owner, and staff cannot give themselves a check-in', async () => {
    await assertSucceeds(updateDoc(doc(owner(), p('orders', 'g1')), { status: 'preparing', updatedBy: 'owner1', updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(kitchen(), p('employees', 'chef1')), { siteCheckUntil: new Date(Date.now() + 3_600_000) }));
  });
});

describe('approved shop devices', () => {
  const kitchen = () => env.authenticatedContext('chef1', { businessId: B, role: 'kitchen', biz: { [B]: 'kitchen' } }).firestore();
  const ticket = { id: 'd1', lines: [{ name: 'Basic Kota', quantity: 1 }], status: 'new', createdAtMillis: 1, createdBy: 'emp1', createdByName: 'Sipho', dayKey: '2026-10-31', updatedBy: 'emp1' };
  const move = () => updateDoc(doc(kitchen(), p('orders', 'd1')), { status: 'preparing', preparingAt: 2, updatedBy: 'chef1', updatedAt: serverTimestamp() });

  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), p('orders', 'd1')), ticket);
      await setDoc(doc(ctx.firestore(), p('businessSettings', 'main')), { devices: { lockToApproved: true, awayAlertMinutes: 60 } });
      await setDoc(doc(ctx.firestore(), p('employees', 'chef1')), { role: 'kitchen', active: true, deviceOkUntil: null });
    });
  });

  it('blocks staff on unapproved devices and allows approved ones', async () => {
    await assertFails(move());
    await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), p('employees', 'chef1')), { deviceOkUntil: new Date(Date.now() + 3_600_000) }));
    await assertSucceeds(move());
  });

  it('device log and activity are owner-only and read-only', async () => {
    await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), p('devices', 'x')), { status: 'approved' }));
    await assertSucceeds(getDoc(doc(owner(), p('devices', 'x'))));
    await assertFails(getDoc(doc(kitchen(), p('devices', 'x'))));
    await assertFails(setDoc(doc(owner(), p('devices', 'x')), { status: 'approved' }));
    await assertFails(getDoc(doc(employee(), p('activity', 'emp1_2026-10-31'))));
  });
});

describe('catalogue', () => {
  it('employees cannot change prices', async () => {
    await assertFails(updateDoc(doc(employee(), p('products', 'basic')), { priceCents: 100, updatedBy: 'emp1', updatedAt: serverTimestamp() }));
  });

  it('owners change prices only with an audit stamp and valid cents', async () => {
    await assertSucceeds(updateDoc(doc(owner(), p('products', 'basic')), { priceCents: 3800, updatedBy: 'owner1', updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(owner(), p('products', 'basic')), { priceCents: 3800 }));
    await assertFails(updateDoc(doc(owner(), p('products', 'basic')), { priceCents: 38.5, updatedBy: 'owner1', updatedAt: serverTimestamp() }));
    await assertFails(deleteDoc(doc(owner(), p('products', 'basic'))));
  });

  it('stock balances can only be moved by the backend', async () => {
    await assertFails(updateDoc(doc(owner(), p('ingredients', 'bread')), { currentQty: 99, updatedBy: 'owner1', updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(doc(owner(), p('ingredients', 'bread')), { reorderLevel: 3, updatedBy: 'owner1', updatedAt: serverTimestamp() }));
  });

  it('new ingredients must start with current = opening stock', async () => {
    const base = { name: 'Cheese', unit: 'slice', openingQty: 40, unitCostCents: 120, reorderLevel: 10, active: true, updatedBy: 'owner1', updatedAt: serverTimestamp() };
    await assertSucceeds(setDoc(doc(owner(), p('ingredients', 'cheese')), { ...base, currentQty: 40 }));
    await assertFails(setDoc(doc(owner(), p('ingredients', 'cheese2')), { ...base, currentQty: 400 }));
  });
});
