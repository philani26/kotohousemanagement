import { initializeApp } from 'firebase-admin/app';
import {
  CollectionReference,
  DocumentReference,
  FieldValue,
  getFirestore,
  Timestamp,
  Transaction,
  WriteBatch,
} from 'firebase-admin/firestore';
import { setGlobalOptions } from 'firebase-functions/v2';
import { CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { DomainError, dayKey } from './shared/domain';
import {
  AppNotification,
  BusinessSettings,
  COLLECTIONS,
  DEFAULT_SETTINGS,
  Employee,
  Role,
  SETTINGS_DOC_ID,
  Shift,
  UserClaims,
  claimMemberships,
} from './shared/models';

/**
 * Keep functions in the same region as the Firestore database. Johannesburg
 * (africa-south1) gives the lowest latency for a South African shop; change
 * this if your Firestore database was created elsewhere.
 */
export const REGION = process.env.FUNCTIONS_REGION || 'africa-south1';

initializeApp();
setGlobalOptions({ region: REGION, maxInstances: 10, memory: '256MiB' });

export const db = getFirestore();
export { FieldValue, Timestamp };

export type Collection = keyof typeof COLLECTIONS;
export type Writer = Transaction | WriteBatch;

/** Transaction.set and WriteBatch.set behave identically; TypeScript cannot call the union directly. */
function put(w: Writer, ref: DocumentReference, data: Record<string, unknown>): void {
  (w as WriteBatch).set(ref, data);
}

export function bizRef(businessId: string): DocumentReference {
  return db.collection(COLLECTIONS.businesses).doc(businessId);
}

export function col(businessId: string, name: Exclude<Collection, 'users' | 'businesses'>): CollectionReference {
  return bizRef(businessId).collection(COLLECTIONS[name]);
}

export function settingsRef(businessId: string): DocumentReference {
  return col(businessId, 'businessSettings').doc(SETTINGS_DOC_ID);
}

export function withSettingsDefaults(data: Partial<BusinessSettings> | undefined): BusinessSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...(data ?? {}),
    thresholds: { ...DEFAULT_SETTINGS.thresholds, ...(data?.thresholds ?? {}) },
    notifications: { ...DEFAULT_SETTINGS.notifications, ...(data?.notifications ?? {}) },
    cctv: { ...DEFAULT_SETTINGS.cctv, ...(data?.cctv ?? {}) },
  };
}

export async function readSettings(businessId: string, tx?: Transaction): Promise<BusinessSettings> {
  const ref = settingsRef(businessId);
  const snap = tx ? await tx.get(ref) : await ref.get();
  return withSettingsDefaults(snap.data() as Partial<BusinessSettings> | undefined);
}

export function todayKey(settings: Pick<BusinessSettings, 'timezone'>, at = new Date()): string {
  return dayKey(at, settings.timezone);
}

export interface Caller {
  uid: string;
  businessId: string;
  role: Role;
  name: string;
}

/**
 * Authenticates a callable request using custom claims, and confirms the
 * employee record is still active (claims alone stay valid for up to an hour).
 * The app sends the shop it is working in as `businessId`; the caller must
 * be a member of that shop. Without it, the default shop from the claims is used.
 */
export async function requireCaller(req: CallableRequest, roles: Role[] = ['owner', 'employee']): Promise<Caller> {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Please sign in');
  const token = req.auth.token as Partial<UserClaims>;
  const memberships = claimMemberships(token);
  const requested = (req.data as { businessId?: unknown } | null)?.businessId;
  const businessId = typeof requested === 'string' && requested ? requested : token.businessId;
  const role = businessId ? memberships[businessId] : undefined;
  if (!businessId || !role) throw new HttpsError('permission-denied', 'Your account is not linked to this shop');
  if (!roles.includes(role)) throw new HttpsError('permission-denied', 'You are not allowed to do this');

  const emp = await col(businessId, 'employees').doc(req.auth.uid).get();
  const data = emp.data() as Employee | undefined;
  if (!data || !data.active) throw new HttpsError('permission-denied', 'Your account has been deactivated');
  return { uid: req.auth.uid, businessId, role, name: data.displayName };
}

/** Converts domain validation failures into client-visible errors. */
export async function handle<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    if (err instanceof DomainError || err instanceof RangeError) {
      throw new HttpsError('invalid-argument', err.message);
    }
    logger.error('Unhandled function error', err);
    throw new HttpsError('internal', 'Something went wrong. Please try again.');
  }
}

export function fail(code: 'invalid-argument' | 'failed-precondition' | 'permission-denied' | 'not-found' | 'already-exists', message: string): never {
  throw new HttpsError(code, message);
}

export function audit(
  w: Writer,
  businessId: string,
  actor: Pick<Caller, 'uid' | 'name' | 'role'> | 'system',
  action: string,
  entity: string,
  entityId: string,
  details: Record<string, unknown> = {},
  tz = DEFAULT_SETTINGS.timezone,
): void {
  const ref = col(businessId, 'auditLogs').doc();
  const a = actor === 'system' ? { uid: 'system', name: 'System', role: 'system' as const } : actor;
  put(w, ref, {
    id: ref.id,
    action,
    entity,
    entityId,
    actorUid: a.uid,
    actorName: a.name,
    actorRole: a.role,
    details: stripUndefined(details),
    at: FieldValue.serverTimestamp(),
    dayKey: dayKey(new Date(), tz),
  });
}

export type NewNotification = Pick<AppNotification, 'type' | 'severity' | 'title' | 'message'> &
  Partial<Pick<AppNotification, 'details' | 'actorName' | 'action' | 'link'>>;

/**
 * Writes an owner notification and, when enabled, queues an email through the
 * Firebase "Trigger Email from Firestore" extension (`mail` collection).
 * WhatsApp delivery is intentionally not implemented until an approved
 * WhatsApp Business API provider has been chosen – see docs/NOTIFICATIONS.md.
 */
export function notify(w: Writer, businessId: string, settings: BusinessSettings, n: NewNotification, id?: string): void {
  const ref = id ? col(businessId, 'notifications').doc(id) : col(businessId, 'notifications').doc();
  const details = (n.details ?? []).filter((d) => d.value !== '' && d.value !== undefined).map((d) => stripUndefined({ ...d }));
  put(w, ref, { id: ref.id, read: false, createdAt: FieldValue.serverTimestamp(), ...stripUndefined({ ...n, details }) });
  if (settings.notifications.email && settings.notifications.emailTo.length && n.severity !== 'info') {
    put(w, db.collection('mail').doc(`${businessId}_${ref.id}`), {
      to: settings.notifications.emailTo,
      message: {
        subject: `[${settings.businessName}] ${n.title}`,
        text: [
          n.message,
          '',
          ...details.map((d) => `${d.label}: ${d.value}`),
          ...(n.actorName ? [`By: ${n.actorName}`] : []),
          ...(n.action ? ['', `What to do: ${n.action}`] : []),
          '',
          'Open the Kota House dashboard to review.',
        ].join('\n'),
      },
    });
  }
}

/** Finds the open shift a caller should work against (employees: their own; owners: any). */
export async function findOpenShift(tx: Transaction, caller: Caller): Promise<Shift | null> {
  let q = col(caller.businessId, 'shifts').where('status', '==', 'open');
  if (caller.role === 'employee') q = q.where('employeeId', '==', caller.uid);
  const snap = await tx.get(q.limit(1));
  return snap.empty ? null : (snap.docs[0].data() as Shift);
}

export function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

export function optionalText(value: unknown, field: string, max = 200): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max) throw new DomainError(`${field} must be at most ${max} characters`);
  return value.trim() || undefined;
}

export function assertReceiptPath(path: string | undefined, caller: Caller): string | undefined {
  if (!path) return undefined;
  const prefix = `businesses/${caller.businessId}/receipts/${caller.uid}/`;
  if (typeof path !== 'string' || !path.startsWith(prefix) || path.includes('..') || path.length > 300) {
    throw new DomainError('Invalid receipt upload');
  }
  return path;
}

/** "Mon 27 Oct, 14:05" in the shop's time zone, for alert details. */
export function localTime(at: Date | number, settings: Pick<BusinessSettings, 'timezone'>): string {
  return new Intl.DateTimeFormat('en-ZA', { timeZone: settings.timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
}

/** "2× Russian Kota, 1× Chips" */
export function itemsText(lines: { name: string; quantity: number }[]): string {
  return lines.map((l) => `${l.quantity}× ${l.name}`).join(', ');
}
