import { Transaction } from 'firebase-admin/firestore';
import { onCall } from 'firebase-functions/v2/https';
import { ApiRequest, ApiResponse } from './shared/api';
import {
  DayActivity,
  DeviceInvite,
  DeviceLocation,
  DeviceStatus,
  INVITE_HOURS,
  MAX_SPANS_KEPT,
  MAX_TRAIL,
  ShopDevice,
  Span,
  clipSpan,
  deviceLabel,
  formatDuration,
  totalMs,
} from './shared/devices';
import { distanceM, isValidPoint } from './shared/geo';
import { requireText } from './shared/domain';
import { BusinessSettings } from './shared/models';
import { Timestamp, audit, col, db, fail, handle, localTime, notify, readSettings, requireCaller, todayKey } from './common';

const DEVICE_ID = /^[A-Za-z0-9-]{16,64}$/;
/** an approved device check lasts this long for the order-ticket security rules */
const DEVICE_OK_HOURS = 12;

/** Epoch millis of a local wall-clock time (hour) on a day in the shop's time zone. */
function localTimeMillis(dayKey: string, hour: number, timeZone: string): number {
  const guess = Date.parse(`${dayKey}T00:00:00Z`) + hour * 3_600_000;
  // offset of the zone at that moment, e.g. +2h for Johannesburg
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(guess))
    .reduce<Record<string, string>>((m, p) => ({ ...m, [p.type]: p.value }), {});
  const asUtc = Date.parse(`${parts['year']}-${parts['month']}-${parts['day']}T${parts['hour']}:${parts['minute']}:00Z`);
  return guess - (asUtc - guess);
}

function cleanSpans(input: unknown, now: number): Span[] {
  if (!Array.isArray(input)) return [];
  return input
    .slice(0, 50)
    .map((s) => ({ from: Number((s as Span).from), to: Number((s as Span).to) }))
    .filter((s) => Number.isFinite(s.from) && Number.isFinite(s.to) && s.to > s.from && s.to <= now + 60_000 && s.from >= now - 24 * 3_600_000);
}

/**
 * Called by the app on sign-in and every couple of minutes. Registers the
 * device (owners' devices are approved automatically), keeps the device log,
 * and adds the worker's "Kota House not on screen" time for today.
 */
export const deviceHeartbeat = onCall<ApiRequest<'deviceHeartbeat'>, Promise<ApiResponse<'deviceHeartbeat'>>>((req) =>
  handle(async () => {
    const caller = await requireCaller(req, ['owner', 'employee', 'kitchen'], { skipSiteCheck: true, skipDeviceCheck: true });
    const d = req.data;
    if (typeof d.deviceId !== 'string' || !DEVICE_ID.test(d.deviceId)) fail('invalid-argument', 'Invalid device');
    const b = caller.businessId;
    const now = Date.now();
    const settings = await readSettings(b);
    const dayKey = todayKey(settings);
    const isStaff = caller.role !== 'owner';
    const userAgent = String(d.userAgent ?? '').slice(0, 300);
    const code = d.deviceId.replace(/-/g, '').slice(0, 4).toUpperCase();

    return db.runTransaction(async (tx) => {
      const deviceRef = col(b, 'devices').doc(d.deviceId);
      const activityRef = col(b, 'activity').doc(`${caller.uid}_${dayKey}`);
      const existing = (await tx.get(deviceRef)).data() as ShopDevice | undefined;
      const activity = isStaff ? ((await tx.get(activityRef)).data() as DayActivity | undefined) : undefined;

      // An owner signing in on a device approves it (e.g. setting up the shop tablet).
      let status: DeviceStatus = existing?.status ?? (isStaff ? 'pending' : 'approved');
      if (!isStaff && status === 'pending') status = 'approved';
      const label = existing?.label ?? deviceLabel(userAgent);

      // Location: only approved shop devices used by staff, only when the owner switched it on,
      // only during trading hours. Owners' own phones are never located.
      const open = localTimeMillis(dayKey, settings.openingHour, settings.timezone);
      const close = localTimeMillis(dayKey, settings.closingHour, settings.timezone);
      const shareLocation = settings.devices.shareLocation && isStaff && status === 'approved';
      let lastLocation = existing?.lastLocation ?? null;
      let trail = (existing?.trail ?? []).filter((p) => p.atMillis >= open); // today only
      const loc = d.location;
      if (shareLocation && now >= open && now < close && loc && isValidPoint(loc) && Number(loc.accuracyM) <= 2000) {
        const fence = settings.geofence;
        const point: DeviceLocation = {
          lat: Math.round(loc.lat * 1e6) / 1e6,
          lng: Math.round(loc.lng * 1e6) / 1e6,
          accuracyM: Math.round(Number(loc.accuracyM)),
          atMillis: now,
          distanceM: fence.lat !== null && fence.lng !== null ? distanceM({ lat: fence.lat, lng: fence.lng }, loc) : null,
        };
        lastLocation = point;
        trail = [...trail, point].slice(-MAX_TRAIL);
      }

      const device: ShopDevice = {
        id: d.deviceId,
        label,
        code,
        userAgent,
        status,
        lastUid: caller.uid,
        lastUserName: caller.name,
        lastSeenMillis: now,
        batteryPct: typeof d.batteryPct === 'number' ? Math.max(0, Math.min(100, Math.round(d.batteryPct))) : null,
        charging: typeof d.charging === 'boolean' ? d.charging : null,
        firstSeenMillis: existing?.firstSeenMillis ?? now,
        lastLocation,
        trail,
      };
      tx.set(deviceRef, device);

      if (!existing) {
        audit(tx, b, caller, 'device.firstSeen', 'devices', d.deviceId, { label, status });
        if (isStaff && settings.devices.lockToApproved) {
          notify(
            tx,
            b,
            settings,
            {
              type: 'newDevice',
              severity: 'warning',
              title: `New device waiting for approval: ${label}`,
              message: `${caller.name} tried to sign in on a device that is not approved (code ${code}).`,
              details: [
                { label: 'Device', value: `${label} (code ${code})` },
                { label: 'Used by', value: caller.name },
                { label: 'When', value: localTime(new Date(now), settings) },
              ],
              actorName: caller.name,
              action: "If it's a shop device, approve it under Devices. If it's someone's personal phone, block it.",
              link: '/devices',
            },
            `device_${d.deviceId}`,
          );
        }
      }

      if (isStaff) {
        tx.update(col(b, 'employees').doc(caller.uid), {
          deviceId: d.deviceId,
          deviceOkUntil: status === 'approved' ? Timestamp.fromMillis(now + DEVICE_OK_HOURS * 3_600_000) : null,
        });

        // away time: only the part inside today's trading hours counts
        const fresh = cleanSpans(d.spans, now)
          .map((s) => clipSpan(s, open, close))
          .filter((s): s is Span => !!s)
          // never count the same stretch twice if the app re-sends after a network error
          .filter((s) => !(activity?.spans ?? []).some((old) => old.from === s.from));
        const before = activity?.awayMs ?? 0;
        const after = before + totalMs(fresh);
        tx.set(activityRef, {
          uid: caller.uid,
          name: caller.name,
          dayKey,
          awayMs: after,
          spans: [...(activity?.spans ?? []), ...fresh].slice(-MAX_SPANS_KEPT),
          deviceId: d.deviceId,
          deviceLabel: label,
          lastSeenMillis: now,
        } satisfies DayActivity);

        const limit = settings.devices.awayAlertMinutes * 60_000;
        if (limit > 0 && before < limit && after >= limit) {
          notifyAway(tx, b, settings, caller.name, caller.uid, dayKey, after, fresh.length + (activity?.spans.length ?? 0), label);
        }
      }
      return { status, code, shareLocation };
    });
  }),
);

function notifyAway(
  tx: Transaction,
  b: string,
  settings: BusinessSettings,
  name: string,
  uid: string,
  dayKey: string,
  awayMs: number,
  times: number,
  device: string,
) {
  notify(
    tx,
    b,
    settings,
    {
      type: 'awayTime',
      severity: 'warning',
      title: `${name}: Kota House off screen for ${formatDuration(awayMs)} today`,
      message: `During trading hours today Kota House was not on screen for ${formatDuration(awayMs)} on ${name}'s device.`,
      details: [
        { label: 'Worker', value: name },
        { label: 'Not on screen today', value: formatDuration(awayMs), tone: 'warn' },
        { label: 'Times away', value: String(times) },
        { label: 'Device', value: device },
        { label: 'Your limit', value: `${settings.devices.awayAlertMinutes} min a day` },
      ],
      actorName: 'System check',
      action: 'This means another app was open OR the screen was off. Look at the timeline under Devices and compare with sales at those times.',
      link: '/devices',
    },
    `away_${uid}_${dayKey}`,
  );
}

/** Owner approves, blocks or renames a device. Blocking signs nobody out by itself, but every till action is refused. */
export const setDevice = onCall<ApiRequest<'setDevice'>, Promise<ApiResponse<'setDevice'>>>((req) =>
  handle(async () => {
    const owner = await requireCaller(req, ['owner']);
    const d = req.data;
    if (typeof d.deviceId !== 'string' || !DEVICE_ID.test(d.deviceId)) fail('invalid-argument', 'Invalid device');
    const ref = col(owner.businessId, 'devices').doc(d.deviceId);
    const snap = await ref.get();
    if (!snap.exists) fail('not-found', 'Device not found');
    const changes: Record<string, unknown> = {};
    if (d.status !== undefined) {
      if (!['approved', 'blocked', 'pending'].includes(d.status)) fail('invalid-argument', 'Invalid status');
      changes['status'] = d.status;
    }
    if (d.label !== undefined) changes['label'] = requireText(d.label, 'Device name', 2, 40);
    const batch = db.batch();
    batch.update(ref, changes);
    // a blocked device stops working for the order-ticket rules straight away
    if (d.status === 'blocked') {
      const users = await col(owner.businessId, 'employees').where('deviceId', '==', d.deviceId).get();
      users.docs.forEach((u) => batch.update(u.ref, { deviceOkUntil: null }));
    }
    audit(batch, owner.businessId, owner, `device.${d.status ?? 'renamed'}`, 'devices', d.deviceId, changes);
    await batch.commit();
    return { ok: true };
  }),
);


/** Owner creates a one-time pairing code for a new shop device (valid for INVITE_HOURS hours). */
export const createDeviceInvite = onCall<ApiRequest<'createDeviceInvite'>, Promise<ApiResponse<'createDeviceInvite'>>>((req) =>
  handle(async () => {
    const owner = await requireCaller(req, ['owner']);
    const label = requireText(req.data.label, 'Device name', 2, 40);
    const expiresAtMillis = Date.now() + INVITE_HOURS * 3_600_000;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const ref = col(owner.businessId, 'deviceInvites').doc(code);
      try {
        await ref.create({ code, label, createdBy: owner.uid, expiresAtMillis, usedByDevice: null } satisfies DeviceInvite);
        return { code, expiresAtMillis };
      } catch {
        // code already taken – try another
      }
    }
    fail('failed-precondition', 'Could not create a code, please try again');
  }),
);

/** A staff member enters the owner's pairing code on a new device: it is approved straight away. */
export const pairDevice = onCall<ApiRequest<'pairDevice'>, Promise<ApiResponse<'pairDevice'>>>((req) =>
  handle(async () => {
    const caller = await requireCaller(req, ['owner', 'employee', 'kitchen'], { skipSiteCheck: true, skipDeviceCheck: true });
    const d = req.data;
    if (typeof d.deviceId !== 'string' || !DEVICE_ID.test(d.deviceId)) fail('invalid-argument', 'Invalid device');
    const code = String(d.code ?? '').replace(/\D/g, '');
    if (code.length !== 6) fail('invalid-argument', 'Enter the 6-digit code from the owner');
    const b = caller.businessId;
    return db.runTransaction(async (tx) => {
      const inviteRef = col(b, 'deviceInvites').doc(code);
      const invite = (await tx.get(inviteRef)).data() as DeviceInvite | undefined;
      if (!invite || invite.usedByDevice || invite.expiresAtMillis < Date.now()) fail('not-found', 'That code is wrong or has expired – ask the owner for a new one');
      const deviceRef = col(b, 'devices').doc(d.deviceId);
      const existing = (await tx.get(deviceRef)).data() as ShopDevice | undefined;
      // a code must not undo the owner blocking a device – they can approve it under Devices instead
      if (existing?.status === 'blocked') fail('permission-denied', 'The owner has blocked this device – a code cannot unblock it');
      const now = Date.now();
      const userAgent = String(d.userAgent ?? '').slice(0, 300);
      tx.set(deviceRef, {
        ...(existing ?? {}),
        id: d.deviceId,
        label: invite.label,
        code: d.deviceId.replace(/-/g, '').slice(0, 4).toUpperCase(),
        userAgent,
        status: 'approved',
        lastUid: caller.uid,
        lastUserName: caller.name,
        lastSeenMillis: now,
        firstSeenMillis: existing?.firstSeenMillis ?? now,
      });
      tx.update(inviteRef, { usedByDevice: d.deviceId });
      if (caller.role !== 'owner') {
        tx.update(col(b, 'employees').doc(caller.uid), { deviceId: d.deviceId, deviceOkUntil: Timestamp.fromMillis(now + DEVICE_OK_HOURS * 3_600_000) });
      }
      audit(tx, b, caller, 'device.paired', 'devices', d.deviceId, { label: invite.label });
      return { status: 'approved' as DeviceStatus, label: invite.label };
    });
  }),
);
