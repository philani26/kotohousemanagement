package za.co.kotahouse.actions;

import static za.co.kotahouse.domain.Domain.num;
import static za.co.kotahouse.domain.Domain.str;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import za.co.kotahouse.audit.AuditLog;
import za.co.kotahouse.common.ApiException;
import za.co.kotahouse.common.Days;
import za.co.kotahouse.domain.Domain;
import za.co.kotahouse.domain.Geo;
import za.co.kotahouse.settings.Settings;
import za.co.kotahouse.settings.SettingsService;
import za.co.kotahouse.shop.Caller;
import za.co.kotahouse.store.Query;
import za.co.kotahouse.store.Store;
import za.co.kotahouse.store.Ts;

/** Work-site check-in and the staff time clock (port of site.ts and hours.ts). */
@RestController
@RequestMapping("/api/rpc")
@Tag(name = "Work site and hours")
public class StaffDayActions {
  static final int MAX_ENTRY_HOURS = 24;

  private final Ctx ctx;
  private final Store store;
  private final SettingsService settingsService;
  private final Notifier notifier;
  private final AuditLog audit;

  public StaffDayActions(Ctx ctx, Store store, SettingsService settingsService, Notifier notifier, AuditLog audit) {
    this.ctx = ctx;
    this.store = store;
    this.settingsService = settingsService;
    this.notifier = notifier;
    this.audit = audit;
  }

  @Operation(summary = "Check in at the shop", description = """
      The app sends the phone's location once after sign-in. Inside the work site, the person may work for the next 12 hours. \
      Only the distance is kept, never the location; the owner is alerted about attempts from outside.""")
  @PostMapping("/checkIn")
  @Transactional
  public Map<String, Object> checkIn(@AuthenticationPrincipal Jwt jwt, @RequestBody Map<String, Object> data) {
    Body d = Body.of(data);
    Caller c = ctx.require(jwt, d, new Ctx.Options(true, false), "owner", "employee", "kitchen");
    Double lat = d.optNumber("lat");
    Double lng = d.optNumber("lng");
    if (!Geo.isValidPoint(lat, lng)) throw ApiException.invalid("Could not read your location");
    String b = c.businessId();
    Settings settings = settingsService.read(b);
    // Owners are never blocked; nothing to check when the work-site check is off.
    if (c.isOwner() || !settings.flag("geofence", "enabled")) return Map.of("ok", true);

    Map<String, Object> fence = settings.section("geofence");
    Geo.Decision decision = Geo.decide(true, toDouble(fence.get("lat")), toDouble(fence.get("lng")), num(fence.get("radiusM")), lat, lng, d.optNumber("accuracyM"));
    if (decision.ok()) {
      long until = System.currentTimeMillis() + Geo.SITE_CHECK_HOURS * 3_600_000L;
      store.update(b, Store.EMPLOYEES, c.uid(), Map.of("siteCheckUntil", Ts.of(until), "siteCheckDistanceM", decision.distanceM()));
      audit.record(c, "site.checkedIn", "employees", c.uid(), Map.of("distanceM", decision.distanceM()));
      return Map.of("ok", true, "distanceM", decision.distanceM(), "until", until);
    }
    Map<String, Object> details = new LinkedHashMap<>();
    details.put("reason", decision.reason());
    details.put("distanceM", decision.distanceM());
    audit.record(c, "site.blocked", "employees", c.uid(), details);
    if ("outside".equals(decision.reason())) {
      notifier.notify(b, settings, Notifier.alert("siteBlocked", "warning", c.name() + " tried to sign in away from the shop")
          .message(c.name() + " was " + Geo.formatDistance(decision.distanceM()) + " from the shop and was blocked.")
          .detail("Who", c.name() + " (" + ("kitchen".equals(c.role()) ? "kitchen" : "cashier") + ")")
          .detail("Distance from the shop", Geo.formatDistance(decision.distanceM()), "bad")
          .detail("Allowed radius", Geo.formatDistance(num(fence.get("radiusM"))))
          .detail("When", Days.localTime(Instant.now(), settings.timezone()))
          .actor(c.name())
          .action("If they were really at the shop, their phone GPS may be off or inaccurate – or widen the radius under Settings › Work site.")
          .link("/employees"));
    }
    Map<String, Object> result = new LinkedHashMap<>();
    result.put("ok", false);
    result.put("reason", decision.reason());
    result.put("distanceM", decision.distanceM());
    return result;
  }

  private static Double toDouble(Object v) {
    return v instanceof Number n ? n.doubleValue() : null;
  }

  private static long minutes(long from, long to) {
    return Math.max(0, Math.round((to - from) / 60_000.0));
  }

  private java.util.Optional<Map<String, Object>> openEntry(Caller c) {
    return store.listForUpdate(c.businessId(), Query.of("timeEntries").where("uid", "==", c.uid()).where("clockOutMillis", "==", null).limit(1).build())
        .stream().findFirst();
  }

  @Operation(summary = "Clock in", description = "Cashiers and kitchen staff, at the shop on an approved device when those checks are on.")
  @PostMapping("/clockIn")
  @Transactional
  public Map<String, Object> clockIn(@AuthenticationPrincipal Jwt jwt, @RequestBody Map<String, Object> data) {
    Body d = Body.of(data);
    Caller c = ctx.require(jwt, d, "employee", "kitchen");
    var open = openEntry(c);
    if (open.isPresent()) return Map.of("entryId", open.get().get("id"), "clockInMillis", open.get().get("clockInMillis"), "alreadyIn", true);
    Settings settings = settingsService.read(c.businessId());
    long now = System.currentTimeMillis();
    String id = store.newId();
    Map<String, Object> entry = new LinkedHashMap<>();
    entry.put("uid", c.uid());
    entry.put("name", c.name());
    entry.put("role", c.role());
    entry.put("dayKey", Days.dayKey(Instant.ofEpochMilli(now), settings.timezone()));
    entry.put("clockInMillis", now);
    entry.put("clockOutMillis", null);
    store.set(c.businessId(), "timeEntries", id, entry);
    audit.record(c, "time.clockIn", "timeEntries", id, Map.of());
    return Map.of("entryId", id, "clockInMillis", now, "alreadyIn", false);
  }

  @Operation(summary = "Clock out", description = "No work-site or device check, so nobody is stuck clocked in.")
  @PostMapping("/clockOut")
  @Transactional
  public Map<String, Object> clockOut(@AuthenticationPrincipal Jwt jwt, @RequestBody Map<String, Object> data) {
    Body d = Body.of(data);
    Caller c = ctx.require(jwt, d, Ctx.Options.SKIP_BOTH, "employee", "kitchen");
    Map<String, Object> e = openEntry(c).orElseThrow(() -> ApiException.precondition("You are not clocked in"));
    long now = System.currentTimeMillis();
    long mins = minutes(Domain.cents(e.get("clockInMillis")), now);
    store.update(c.businessId(), "timeEntries", str(e.get("id")), Map.of("clockOutMillis", now, "minutes", mins));
    audit.record(c, "time.clockOut", "timeEntries", str(e.get("id")), Map.of("minutes", mins));
    return Map.of("minutes", mins);
  }

  @Operation(summary = "Set a clock-out time", description = "Owner: a forgotten clock-out or a correction, with a reason (kept in the activity log).")
  @PostMapping("/fixTimeEntry")
  @Transactional
  public Map<String, Object> fixTimeEntry(@AuthenticationPrincipal Jwt jwt, @RequestBody Map<String, Object> data) {
    Body d = Body.of(data);
    Caller owner = ctx.require(jwt, d, "owner");
    String reason = d.text("reason", "Reason", 3, 200);
    Long out = d.optLong("clockOutMillis");
    String id = d.str("entryId");
    Map<String, Object> e = store.getForUpdate(owner.businessId(), "timeEntries", id).orElseThrow(() -> ApiException.notFound("Time entry not found"));
    long in = Domain.cents(e.get("clockInMillis"));
    if (out == null || out <= in) throw ApiException.invalid("Clock-out must be after clock-in");
    if (out > System.currentTimeMillis() + 60_000) throw ApiException.invalid("Clock-out cannot be in the future");
    if (out - in > MAX_ENTRY_HOURS * 3_600_000L) throw ApiException.invalid("One entry can be at most " + MAX_ENTRY_HOURS + " hours");
    long mins = minutes(in, out);
    store.update(owner.businessId(), "timeEntries", id, Map.of("clockOutMillis", out, "minutes", mins, "fixedBy", owner.name(), "fixReason", reason));
    Map<String, Object> details = new LinkedHashMap<>();
    details.put("worker", e.get("name"));
    details.put("before", e.get("clockOutMillis"));
    details.put("after", out);
    details.put("hours", (mins / 60) + " h " + String.format("%02d", mins % 60) + " min");
    details.put("reason", reason);
    audit.record(owner, "time.fixed", "timeEntries", id, details);
    return Map.of("ok", true);
  }
}
