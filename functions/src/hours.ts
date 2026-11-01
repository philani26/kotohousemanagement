import { onCall } from 'firebase-functions/v2/https';
import { ApiRequest, ApiResponse } from './shared/api';
import { MAX_ENTRY_HOURS, TimeEntry, entryMinutes, formatHours } from './shared/hours';
import { requireText } from './shared/domain';
import { audit, col, db, fail, handle, readSettings, requireCaller, todayKey } from './common';

/**
 * Staff clock in on the shop device. The usual work-site and approved-device
 * checks apply, so a clock-in from home is refused when those are switched on.
 */
export const clockIn = onCall<ApiRequest<'clockIn'>, Promise<ApiResponse<'clockIn'>>>((req) =>
  handle(async () => {
    const caller = await requireCaller(req, ['employee', 'kitchen']);
    const b = caller.businessId;
    const settings = await readSettings(b);
    const now = Date.now();
    return db.runTransaction(async (tx) => {
      const open = await tx.get(col(b, 'timeEntries').where('uid', '==', caller.uid).where('clockOutMillis', '==', null).limit(1));
      if (!open.empty) {
        const e = open.docs[0].data() as TimeEntry;
        return { entryId: e.id, clockInMillis: e.clockInMillis, alreadyIn: true };
      }
      const ref = col(b, 'timeEntries').doc();
      const entry: TimeEntry = {
        id: ref.id,
        uid: caller.uid,
        name: caller.name,
        role: caller.role,
        dayKey: todayKey(settings, new Date(now)),
        clockInMillis: now,
        clockOutMillis: null,
      };
      tx.set(ref, entry);
      audit(tx, b, caller, 'time.clockIn', 'timeEntries', ref.id, {});
      return { entryId: ref.id, clockInMillis: now, alreadyIn: false };
    });
  }),
);

/** Ends the caller's open clock-in. No site/device check, so nobody is stuck clocked in. */
export const clockOut = onCall<ApiRequest<'clockOut'>, Promise<ApiResponse<'clockOut'>>>((req) =>
  handle(async () => {
    const caller = await requireCaller(req, ['employee', 'kitchen'], { skipSiteCheck: true, skipDeviceCheck: true });
    const b = caller.businessId;
    const now = Date.now();
    return db.runTransaction(async (tx) => {
      const open = await tx.get(col(b, 'timeEntries').where('uid', '==', caller.uid).where('clockOutMillis', '==', null).limit(1));
      if (open.empty) fail('failed-precondition', 'You are not clocked in');
      const e = open.docs[0].data() as TimeEntry;
      const minutes = entryMinutes({ clockInMillis: e.clockInMillis, clockOutMillis: now }, now);
      tx.update(open.docs[0].ref, { clockOutMillis: now, minutes });
      audit(tx, b, caller, 'time.clockOut', 'timeEntries', e.id, { minutes });
      return { minutes };
    });
  }),
);

/** Owner sets the clock-out time of an entry (forgotten clock-out, or a correction). */
export const fixTimeEntry = onCall<ApiRequest<'fixTimeEntry'>, Promise<ApiResponse<'fixTimeEntry'>>>((req) =>
  handle(async () => {
    const owner = await requireCaller(req, ['owner']);
    const reason = requireText(req.data.reason, 'Reason', 3, 200);
    const out = Number(req.data.clockOutMillis);
    const ref = col(owner.businessId, 'timeEntries').doc(String(req.data.entryId));
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) fail('not-found', 'Time entry not found');
      const e = snap.data() as TimeEntry;
      if (!Number.isFinite(out) || out <= e.clockInMillis) fail('invalid-argument', 'Clock-out must be after clock-in');
      if (out > Date.now() + 60_000) fail('invalid-argument', 'Clock-out cannot be in the future');
      if (out - e.clockInMillis > MAX_ENTRY_HOURS * 3_600_000) fail('invalid-argument', `One entry can be at most ${MAX_ENTRY_HOURS} hours`);
      const minutes = entryMinutes({ clockInMillis: e.clockInMillis, clockOutMillis: out }, out);
      tx.update(ref, { clockOutMillis: out, minutes, fixedBy: owner.name, fixReason: reason });
      audit(tx, owner.businessId, owner, 'time.fixed', 'timeEntries', e.id, {
        worker: e.name,
        before: e.clockOutMillis,
        after: out,
        hours: formatHours(minutes),
        reason,
      });
    });
    return { ok: true };
  }),
);
