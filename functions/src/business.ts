import { getAuth } from 'firebase-admin/auth';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { ApiRequest, ApiResponse } from './shared/api';
import { requireText } from './shared/domain';
import { COLLECTIONS, DEFAULT_SETTINGS, Employee, Role, UserClaims, claimMemberships } from './shared/models';
import { FieldValue, audit, col, db, fail, handle, optionalText, requireCaller, settingsRef } from './common';

/**
 * Optional allow-list of emails that may create a business, configured in
 * functions/.env (OWNER_EMAILS=a@x.co.za,b@y.co.za). Leave empty to allow any
 * verified sign-up to create its own, isolated business.
 */
function ownerAllowed(email: string | undefined): boolean {
  const list = (process.env.OWNER_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return list.length === 0 || (!!email && list.includes(email.toLowerCase()));
}

const MAX_SHOPS_PER_OWNER = 20;

/**
 * Creates a shop and makes the caller its owner. Used for the very first shop
 * and when an owner opens another kota house. Each shop is a separate tenant
 * with its own menu, stock, cash, staff and reports; the owner's claims list
 * every shop they belong to (`biz`).
 */
export const setupBusiness = onCall<ApiRequest<'setupBusiness'>, Promise<ApiResponse<'setupBusiness'>>>((req) =>
  handle(async () => {
    if (!req.auth) throw new HttpsError('unauthenticated', 'Please sign in');
    const token = req.auth.token as Partial<UserClaims> & { email?: string };
    const memberships = claimMemberships(token);
    const existing = Object.keys(memberships);
    if (existing.length && !Object.values(memberships).includes('owner')) {
      fail('permission-denied', 'Only a shop owner can add another shop');
    }
    if (existing.length >= MAX_SHOPS_PER_OWNER) fail('failed-precondition', `You can have up to ${MAX_SHOPS_PER_OWNER} shops`);
    if (!ownerAllowed(token.email)) fail('permission-denied', 'This email is not allowed to create a business');

    const businessName = requireText(req.data.businessName, 'Business name', 2, 80);
    const displayName = requireText(req.data.displayName, 'Your name', 2, 60);
    const uid = req.auth.uid;
    const business = db.collection(COLLECTIONS.businesses).doc();
    const businessId = business.id;
    const owner = { uid, name: displayName, role: 'owner' as Role };

    const batch = db.batch();
    batch.set(business, { id: businessId, name: businessName, ownerUid: uid, receiptCounter: 0, createdAt: FieldValue.serverTimestamp() });
    batch.set(settingsRef(businessId), { ...DEFAULT_SETTINGS, businessName, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    const employee: Omit<Employee, 'createdAt'> = {
      uid,
      displayName,
      email: token.email ?? '',
      role: 'owner',
      active: true,
      createdBy: uid,
    };
    batch.set(col(businessId, 'employees').doc(uid), { ...employee, createdAt: FieldValue.serverTimestamp() });
    const userRef = db.collection(COLLECTIONS.users).doc(uid);
    const membership = { memberships: { [businessId]: { name: businessName, role: 'owner' } } };
    if (existing.length === 0) {
      batch.set(userRef, {
        uid,
        email: token.email ?? '',
        displayName,
        businessId,
        role: 'owner',
        active: true,
        createdAt: FieldValue.serverTimestamp(),
        ...membership,
      });
    } else {
      batch.set(userRef, membership, { merge: true });
    }
    audit(batch, businessId, owner, 'business.created', 'businesses', businessId, { businessName, additionalShop: existing.length > 0 });
    await batch.commit();

    // Keep the existing default shop; the app switches to the new one itself.
    const claims: UserClaims = {
      businessId: token.businessId ?? businessId,
      role: token.role ?? 'owner',
      biz: { ...memberships, [businessId]: 'owner' },
    };
    await getAuth().setCustomUserClaims(uid, claims);
    return { businessId };
  }),
);

/** Owner creates a staff login. Employees can never create users or change roles. */
export const createEmployee = onCall<ApiRequest<'createEmployee'>, Promise<ApiResponse<'createEmployee'>>>((req) =>
  handle(async () => {
    const owner = await requireCaller(req, ['owner']);
    const d = req.data;
    const displayName = requireText(d.displayName, 'Name', 2, 60);
    const email = requireText(d.email, 'Email', 5, 120).toLowerCase();
    if (typeof d.password !== 'string' || d.password.length < 8) fail('invalid-argument', 'Password must be at least 8 characters');
    const role: Role = d.role === 'owner' ? 'owner' : 'employee';
    const phone = optionalText(d.phone, 'Phone', 20);

    const user = await getAuth().createUser({ email, password: d.password, displayName });
    await getAuth().setCustomUserClaims(user.uid, { businessId: owner.businessId, role, biz: { [owner.businessId]: role } } satisfies UserClaims);

    const batch = db.batch();
    batch.set(col(owner.businessId, 'employees').doc(user.uid), {
      uid: user.uid,
      displayName,
      email,
      ...(phone ? { phone } : {}),
      role,
      active: true,
      createdBy: owner.uid,
      createdAt: FieldValue.serverTimestamp(),
    });
    batch.set(db.collection(COLLECTIONS.users).doc(user.uid), {
      uid: user.uid,
      email,
      displayName,
      businessId: owner.businessId,
      role,
      active: true,
      createdAt: FieldValue.serverTimestamp(),
      memberships: { [owner.businessId]: { name: (await settingsRef(owner.businessId).get()).get('businessName') ?? '', role } },
    });
    audit(batch, owner.businessId, owner, 'employee.created', 'employees', user.uid, { displayName, email, role });
    await batch.commit();
    return { uid: user.uid };
  }),
);

export const updateEmployee = onCall<ApiRequest<'updateEmployee'>, Promise<ApiResponse<'updateEmployee'>>>((req) =>
  handle(async () => {
    const owner = await requireCaller(req, ['owner']);
    const d = req.data;
    const ref = col(owner.businessId, 'employees').doc(String(d.uid));
    const snap = await ref.get();
    if (!snap.exists) fail('not-found', 'Employee not found');
    if (d.uid === owner.uid && d.active === false) fail('failed-precondition', 'You cannot deactivate your own account');

    const changes: Record<string, unknown> = {};
    if (typeof d.active === 'boolean') changes['active'] = d.active;
    if (d.displayName !== undefined) changes['displayName'] = requireText(d.displayName, 'Name', 2, 60);
    if (d.phone !== undefined) changes['phone'] = optionalText(d.phone, 'Phone', 20) ?? '';
    if (d.password !== undefined && (typeof d.password !== 'string' || d.password.length < 8)) {
      fail('invalid-argument', 'Password must be at least 8 characters');
    }

    await getAuth().updateUser(d.uid, {
      ...(typeof d.active === 'boolean' ? { disabled: !d.active } : {}),
      ...(changes['displayName'] ? { displayName: changes['displayName'] as string } : {}),
      ...(d.password ? { password: d.password } : {}),
    });
    if (d.active === false || d.password) await getAuth().revokeRefreshTokens(d.uid);

    const batch = db.batch();
    if (Object.keys(changes).length) {
      batch.update(ref, changes);
      const userChanges = { ...changes };
      delete userChanges['phone'];
      if (Object.keys(userChanges).length) batch.update(db.collection(COLLECTIONS.users).doc(d.uid), userChanges);
    }
    audit(batch, owner.businessId, owner, 'employee.updated', 'employees', d.uid, {
      ...changes,
      passwordReset: !!d.password,
    });
    await batch.commit();
    return { ok: true };
  }),
);
