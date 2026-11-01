import { onCall } from 'firebase-functions/v2/https';
import { ApiRequest, ApiResponse } from './shared/api';
import { SITE_CHECK_HOURS, decideSiteCheck, formatDistance, isValidPoint } from './shared/geo';
import { Timestamp, audit, col, db, fail, handle, localTime, notify, readSettings, requireCaller } from './common';

/**
 * Work-site check-in. The app sends the phone's location once, right after
 * sign-in; if it is within the shop's geofence the worker may use the till for
 * the next few hours. Only the distance is stored – never the location itself –
 * and the owner is alerted about attempts from outside the site.
 */
export const checkIn = onCall<ApiRequest<'checkIn'>, Promise<ApiResponse<'checkIn'>>>((req) =>
  handle(async () => {
    const caller = await requireCaller(req, ['owner', 'employee', 'kitchen'], { skipSiteCheck: true });
    const at = { lat: Number(req.data.lat), lng: Number(req.data.lng) };
    if (!isValidPoint(at)) fail('invalid-argument', 'Could not read your location');
    const b = caller.businessId;
    const settings = await readSettings(b);

    // Owners are never blocked; nothing to check when the geofence is off.
    if (caller.role === 'owner' || !settings.geofence.enabled) return { ok: true };

    const decision = decideSiteCheck(settings.geofence, at, Number(req.data.accuracyM));
    const batch = db.batch();
    if (decision.ok) {
      const until = Date.now() + SITE_CHECK_HOURS * 3_600_000;
      batch.update(col(b, 'employees').doc(caller.uid), {
        siteCheckUntil: Timestamp.fromMillis(until),
        siteCheckDistanceM: decision.distanceM,
      });
      audit(batch, b, caller, 'site.checkedIn', 'employees', caller.uid, { distanceM: decision.distanceM });
      await batch.commit();
      return { ok: true, distanceM: decision.distanceM, until };
    }

    audit(batch, b, caller, 'site.blocked', 'employees', caller.uid, { reason: decision.reason, distanceM: decision.distanceM });
    if (decision.reason === 'outside') {
      notify(batch, b, settings, {
        type: 'siteBlocked',
        severity: 'warning',
        title: `${caller.name} tried to sign in away from the shop`,
        message: `${caller.name} was ${formatDistance(decision.distanceM!)} from the shop and was blocked.`,
        details: [
          { label: 'Who', value: `${caller.name} (${caller.role === 'kitchen' ? 'kitchen' : 'cashier'})` },
          { label: 'Distance from the shop', value: formatDistance(decision.distanceM!), tone: 'bad' },
          { label: 'Allowed radius', value: formatDistance(settings.geofence.radiusM) },
          { label: 'When', value: localTime(new Date(), settings) },
        ],
        actorName: caller.name,
        action: 'If they were really at the shop, their phone GPS may be off or inaccurate – or widen the radius under Settings › Work site.',
        link: '/employees',
      });
    }
    await batch.commit();
    return { ok: false, reason: decision.reason, distanceM: decision.distanceM };
  }),
);
