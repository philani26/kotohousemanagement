package za.co.kotahouse.actions;

import static za.co.kotahouse.domain.Domain.cents;
import static za.co.kotahouse.domain.Domain.formatZar;
import static za.co.kotahouse.domain.Domain.str;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;
import za.co.kotahouse.common.Days;
import za.co.kotahouse.domain.Domain;
import za.co.kotahouse.settings.Settings;
import za.co.kotahouse.settings.SettingsService;
import za.co.kotahouse.store.Query;
import za.co.kotahouse.store.Store;
import za.co.kotahouse.store.Ts;

/**
 * Every 15 minutes: a shift not closed after hours, a shop that hasn't opened,
 * and long periods without sales (port of scheduled.ts monitorActivity).
 * Each alert has a fixed id, so it is raised at most once.
 */
@Component
public class MonitorJob {
  private static final Logger log = LoggerFactory.getLogger(MonitorJob.class);
  /** only one server runs a check at a time */
  private static final long LOCK = 0x4b4f5441L; // "KOTA"

  private final JdbcClient db;
  private final Store store;
  private final SettingsService settingsService;
  private final Notifier notifier;
  private final TransactionTemplate tx;

  public MonitorJob(JdbcClient db, Store store, SettingsService settingsService, Notifier notifier, TransactionTemplate tx) {
    this.db = db;
    this.store = store;
    this.settingsService = settingsService;
    this.notifier = notifier;
    this.tx = tx;
  }

  @Scheduled(fixedDelayString = "${kotahouse.monitor-interval:15m}", initialDelayString = "${kotahouse.monitor-initial-delay:2m}")
  public void run() {
    Boolean mine = tx.execute(t -> db.sql("select pg_try_advisory_xact_lock(:k)").param("k", LOCK).query(Boolean.class).single());
    if (!Boolean.TRUE.equals(mine)) return;
    List<String> shops = db.sql("select id from businesses").query(String.class).list();
    for (String b : shops) {
      try {
        tx.executeWithoutResult(t -> check(b, System.currentTimeMillis()));
      } catch (Exception e) {
        log.error("monitorActivity failed for {}", b, e);
      }
    }
  }

  private static long minutesSince(Object ts, long now) {
    Long ms = Ts.millis(ts);
    return ms == null ? Long.MAX_VALUE : (now - ms) / 60_000;
  }

  private String local(Object ts, Settings s) {
    Long ms = Ts.millis(ts);
    return ms == null ? "" : Days.localTime(Instant.ofEpochMilli(ms), s.timezone());
  }

  private void raiseOnce(String b, String id, Settings s, Notifier.Builder alert) {
    if (store.getForUpdate(b, Notifier.COLLECTION, id).isPresent()) return;
    notifier.notify(b, s, alert, id);
  }

  void check(String b, long now) {
    Settings s = settingsService.read(b);
    String today = Days.dayKey(Instant.ofEpochMilli(now), s.timezone());
    int hour = Days.localHour(Instant.ofEpochMilli(now), s.timezone());
    int weekday = Days.localWeekday(Instant.ofEpochMilli(now), s.timezone());
    boolean tradingToday = s.data().get("tradingDays") instanceof List<?> l && l.stream().anyMatch(d -> d instanceof Number n && n.intValue() == weekday);
    long graceMin = (long) s.threshold("missingCloseGraceMinutes");
    long noSaleMin = (long) s.threshold("noSaleMinutes");
    var open = store.list(b, Query.of("shifts").where("status", "==", "open").build());

    for (Map<String, Object> shift : open) {
      boolean pastClose = (hour - s.closingHour()) * 60L >= graceMin;
      String name = str(shift.get("employeeName"));
      if (str(shift.get("dayKey")).compareTo(today) < 0 || pastClose) {
        var session = store.get(b, "cashSessions", str(shift.get("cashSessionId"))).orElse(null);
        long openFor = minutesSince(shift.get("openedAt"), now);
        var a = Notifier.alert("missingClose", "critical", "Closing report missing")
            .message(name + "'s shift from " + shift.get("dayKey") + " has not been closed and cashed up.")
            .detail("Cashier", name)
            .detail("Shift opened", local(shift.get("openedAt"), s))
            .detail("Open for", (openFor / 60) + "h " + (openFor % 60) + "m", "bad")
            .detail("Closing time", s.closingHour() + ":00 (+" + graceMin + " min grace)")
            .detail("Last sale", shift.get("lastSaleAt") != null ? local(shift.get("lastSaleAt"), s) : "No sales");
        if (session != null) {
          a.detail("Cash that should be in the till", formatZar(Domain.expectedCash(session)), "warn")
              .detail("Card / EFT so far", formatZar(cents(session.get("cardSalesCents"))) + " / " + formatZar(cents(session.get("eftSalesCents"))));
        }
        raiseOnce(b, "missingClose_" + shift.get("id") + "_" + today, s, a.actor("System check")
            .action("Call " + name + " to count the cash and close the shift. Until then this cash is not reconciled.").link("/cash"));
        continue;
      }
      boolean inTradingHours = tradingToday && hour >= s.openingHour() + 1 && hour < s.closingHour();
      Object since = shift.get("lastSaleAt") != null ? shift.get("lastSaleAt") : shift.get("openedAt");
      long quiet = minutesSince(since, now);
      if (inTradingHours && noSaleMin > 0 && quiet >= noSaleMin) {
        long window = quiet / noSaleMin;
        raiseOnce(b, "noSales_" + shift.get("id") + "_" + window, s, Notifier.alert("noSales", "warning", "No sales for " + (quiet / 60) + "h " + (quiet % 60) + "m")
            .message("No sale has been recorded on " + name + "'s shift since " + local(since, s) + ".")
            .detail("Cashier on shift", name)
            .detail("Last sale", shift.get("lastSaleAt") != null ? local(shift.get("lastSaleAt"), s) : "None since opening at " + local(shift.get("openedAt"), s))
            .detail("Quiet for", (quiet / 60) + "h " + (quiet % 60) + "m", "warn")
            .detail("Alert after", noSaleMin + " min without a sale (Settings)")
            .actor("System check")
            .action("Check the shop is open and trading. If customers are being served, sales may not be rung up – look at the CCTV.")
            .link("/dashboard"));
      }
    }

    if (open.isEmpty() && tradingToday && hour >= s.openingHour() + 1 && hour < s.closingHour()) {
      boolean openedToday = !store.list(b, Query.of("shifts").where("dayKey", "==", today).limit(1).build()).isEmpty();
      if (!openedToday) {
        raiseOnce(b, "notOpened_" + today, s, Notifier.alert("notOpened", "warning", "Shop not opened")
            .message("No shift has been opened today (expected from " + s.openingHour() + ":00).")
            .detail("Expected opening", s.openingHour() + ":00")
            .detail("Checked at", Days.localTime(Instant.ofEpochMilli(now), s.timezone()))
            .detail("Shifts today", "None", "bad")
            .actor("System check")
            .action("Call your cashier. If the shop is closed today, untick this day under Settings › Trading days.")
            .link("/dashboard"));
      }
    }
  }
}
