import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions';
import { expectedCash, localHour, localWeekday } from './shared/domain';
import { CashSession, Shift } from './shared/models';
import { formatZar } from './shared/money';
import { NewNotification, Timestamp, col, db, localTime, notify, readSettings, todayKey } from './common';

function minutesSince(t: Timestamp | undefined, now: number): number {
  return t ? Math.floor((now - t.toMillis()) / 60_000) : Infinity;
}

/** Notifications use deterministic ids, so each alert is raised at most once. */
async function raiseOnce(businessId: string, id: string, n: NewNotification, settings: Awaited<ReturnType<typeof readSettings>>) {
  const ref = col(businessId, 'notifications').doc(id);
  await db.runTransaction(async (tx) => {
    if ((await tx.get(ref)).exists) return;
    notify(tx, businessId, settings, n, id);
  });
}

/**
 * Every 15 minutes: flags missing closing reports, a shop that has not opened,
 * and long periods without sales during trading hours. Thresholds come from
 * business settings so the owner can tune out unnecessary alerts.
 */
export const monitorActivity = onSchedule({ schedule: 'every 15 minutes', timeZone: 'Africa/Johannesburg' }, async () => {
  const businesses = await db.collection('businesses').select().get();
  const now = Date.now();

  for (const biz of businesses.docs) {
    const b = biz.id;
    try {
      const settings = await readSettings(b);
      const t = settings.thresholds;
      const today = todayKey(settings);
      const hour = localHour(new Date(now), settings.timezone);
      const tradingToday = settings.tradingDays.includes(localWeekday(new Date(now), settings.timezone));
      const open = await col(b, 'shifts').where('status', '==', 'open').get();

      for (const doc of open.docs) {
        const shift = doc.data() as Shift & { openedAt: Timestamp; lastSaleAt?: Timestamp };
        const pastClose = (hour - settings.closingHour) * 60 >= t.missingCloseGraceMinutes;
        if (shift.dayKey < today || pastClose) {
          const session = (await col(b, 'cashSessions').doc(shift.cashSessionId).get()).data() as CashSession | undefined;
          const openFor = minutesSince(shift.openedAt, now);
          await raiseOnce(b, `missingClose_${shift.id}_${today}`, {
            type: 'missingClose',
            severity: 'critical',
            title: 'Closing report missing',
            message: `${shift.employeeName}'s shift from ${shift.dayKey} has not been closed and cashed up.`,
            details: [
              { label: 'Cashier', value: shift.employeeName },
              { label: 'Shift opened', value: localTime(shift.openedAt.toDate(), settings) },
              { label: 'Open for', value: `${Math.floor(openFor / 60)}h ${openFor % 60}m`, tone: 'bad' },
              { label: 'Closing time', value: `${settings.closingHour}:00 (+${t.missingCloseGraceMinutes} min grace)` },
              { label: 'Last sale', value: shift.lastSaleAt ? localTime(shift.lastSaleAt.toDate(), settings) : 'No sales' },
              ...(session
                ? [
                    { label: 'Cash that should be in the till', value: formatZar(expectedCash(session)), tone: 'warn' as const },
                    { label: 'Card / EFT so far', value: `${formatZar(session.cardSalesCents)} / ${formatZar(session.eftSalesCents)}` },
                  ]
                : []),
            ],
            actorName: 'System check',
            action: `Call ${shift.employeeName} to count the cash and close the shift. Until then this cash is not reconciled.`,
            link: '/cash',
          }, settings);
          continue;
        }
        const inTradingHours = tradingToday && hour >= settings.openingHour + 1 && hour < settings.closingHour;
        const quiet = minutesSince(shift.lastSaleAt ?? shift.openedAt, now);
        if (inTradingHours && quiet >= t.noSaleMinutes) {
          const window = Math.floor(quiet / t.noSaleMinutes);
          await raiseOnce(b, `noSales_${shift.id}_${window}`, {
            type: 'noSales',
            severity: 'warning',
            title: `No sales for ${Math.floor(quiet / 60)}h ${quiet % 60}m`,
            message: `No sale has been recorded on ${shift.employeeName}'s shift since ${(shift.lastSaleAt ?? shift.openedAt).toDate().toLocaleTimeString('en-ZA', { timeZone: settings.timezone, hour: '2-digit', minute: '2-digit' })}.`,
            details: [
              { label: 'Cashier on shift', value: shift.employeeName },
              { label: 'Last sale', value: shift.lastSaleAt ? localTime(shift.lastSaleAt.toDate(), settings) : `None since opening at ${localTime(shift.openedAt.toDate(), settings)}` },
              { label: 'Quiet for', value: `${Math.floor(quiet / 60)}h ${quiet % 60}m`, tone: 'warn' },
              { label: 'Alert after', value: `${t.noSaleMinutes} min without a sale (Settings)` },
            ],
            actorName: 'System check',
            action: 'Check the shop is open and trading. If customers are being served, sales may not be rung up – look at the CCTV.',
            link: '/dashboard',
          }, settings);
        }
      }

      if (open.empty && tradingToday && hour >= settings.openingHour + 1 && hour < settings.closingHour) {
        const todays = await col(b, 'shifts').where('dayKey', '==', today).limit(1).get();
        if (todays.empty) {
          await raiseOnce(b, `notOpened_${today}`, {
            type: 'notOpened',
            severity: 'warning',
            title: 'Shop not opened',
            message: `No shift has been opened today (expected from ${settings.openingHour}:00).`,
            details: [
              { label: 'Expected opening', value: `${settings.openingHour}:00` },
              { label: 'Checked at', value: localTime(new Date(now), settings) },
              { label: 'Shifts today', value: 'None', tone: 'bad' },
            ],
            actorName: 'System check',
            action: 'Call your cashier. If the shop is closed today, untick this day under Settings › Trading days.',
            link: '/dashboard',
          }, settings);
        }
      }
    } catch (err) {
      logger.error(`monitorActivity failed for ${b}`, err);
    }
  }
});
