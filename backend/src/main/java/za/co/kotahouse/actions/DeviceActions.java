package za.co.kotahouse.actions;

import static za.co.kotahouse.domain.Domain.cents;
import static za.co.kotahouse.domain.Domain.str;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
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
import za.co.kotahouse.domain.Devices;
import za.co.kotahouse.domain.Domain;
import za.co.kotahouse.domain.Geo;
import za.co.kotahouse.settings.Settings;
import za.co.kotahouse.settings.SettingsService;
import za.co.kotahouse.shop.Caller;
import za.co.kotahouse.store.Store;
import za.co.kotahouse.store.Ts;

/** Shop devices: device log, approval, pairing codes and off-screen time (port of devices.ts). */
@RestController
@RequestMapping("/api/rpc")
@Tag(name = "Devices")
public class DeviceActions {
  private static final String DEVICE_ID = "^[A-Za-z0-9-]{16,64}$";
  /** an approved device check lasts this long */
  private static final int DEVICE_OK_HOURS = 12;
  private static final SecureRandom RANDOM = new SecureRandom();

  private final Ctx ctx;
  private final Store store;
  private final SettingsService settingsService;
  private final Notifier notifier;
  private final AuditLog audit;

  public DeviceActions(Ctx ctx, Store store, SettingsService settingsService, Notifier notifier, AuditLog audit) {
    this.ctx = ctx;
    this.store = store;
    this.settingsService = settingsService;
    this.notifier = notifier;
    this.audit = audit;
  }

  private static String deviceId(Body d) {
    String id = d.str("deviceId");
    if (!id.matches(DEVICE_ID)) throw ApiException.invalid("Invalid device");
    return id;
  }

  private static String code(String deviceId) {
    return deviceId.replace("-", "").substring(0, 4).toUpperCase();
  }

  @Operation(summary = "Device heartbeat", description = """
      The app calls this at sign-in and every couple of minutes: registers the device (an owner's are approved automatically), \
      keeps the device log, and adds the worker's time with Kota House off screen during trading hours.""")
  @PostMapping("/deviceHeartbeat")
  @Transactional
  public Map<String, Object> deviceHeartbeat(@AuthenticationPrincipal Jwt jwt, @RequestBody Map<String, Object> data) {
    Body d = Body.of(data);
    Caller c = ctx.require(jwt, d, Ctx.Options.SKIP_BOTH, "owner", "employee", "kitchen");
    String id = deviceId(d);
    String b = c.businessId();
    long now = System.currentTimeMillis();
    Settings settings = settingsService.read(b);
    String dayKey = Effects.todayKey(settings);
    boolean isStaff = !c.isOwner();
    String ua = d.str("userAgent");
    if (ua.length() > 300) ua = ua.substring(0, 300);
    String code = code(id);

    Map<String, Object> existing = store.getForUpdate(b, "devices", id).orElse(null);
    String activityId = c.uid() + "_" + dayKey;
    Map<String, Object> activity = isStaff ? store.getForUpdate(b, "activity", activityId).orElse(null) : null;

    // An owner signing in on a device approves it (e.g. setting up the shop tablet).
    String status = existing != null ? str(existing.get("status")) : isStaff ? "pending" : "approved";
    if (!isStaff && "pending".equals(status)) status = "approved";
    String label = existing != null ? str(existing.get("label")) : Devices.deviceLabel(ua);

    // Location: only approved shop devices used by staff, only when switched on, only during trading hours.
    long open = Devices.localTimeMillis(dayKey, settings.openingHour(), settings.timezone());
    long close = Devices.localTimeMillis(dayKey, settings.closingHour(), settings.timezone());
    boolean shareLocation = settings.flag("devices", "shareLocation") && isStaff && "approved".equals(status);
    Object lastLocation = existing == null ? null : existing.get("lastLocation");
    List<Map<String, Object>> trail = new ArrayList<>();
    if (existing != null) for (Map<String, Object> p : Domain.list(existing.get("trail"))) if (cents(p.get("atMillis")) >= open) trail.add(p);
    Body loc = d.obj("location");
    Double lat = loc.optNumber("lat");
    Double lng = loc.optNumber("lng");
    Double acc = loc.optNumber("accuracyM");
    if (shareLocation && now >= open && now < close && Geo.isValidPoint(lat, lng) && acc != null && acc <= 2000) {
      Map<String, Object> fence = settings.section("geofence");
      Map<String, Object> point = new LinkedHashMap<>();
      point.put("lat", Math.round(lat * 1e6) / 1e6);
      point.put("lng", Math.round(lng * 1e6) / 1e6);
      point.put("accuracyM", Math.round(acc));
      point.put("atMillis", now);
      point.put("distanceM", fence.get("lat") instanceof Number fl && fence.get("lng") instanceof Number fg
          ? Geo.distanceM(fl.doubleValue(), fg.doubleValue(), lat, lng) : null);
      lastLocation = point;
      trail.add(point);
      if (trail.size() > Devices.MAX_TRAIL) trail = trail.subList(trail.size() - Devices.MAX_TRAIL, trail.size());
    }

    Map<String, Object> device = new LinkedHashMap<>();
    device.put("label", label);
    device.put("code", code);
    device.put("userAgent", ua);
    device.put("status", status);
    device.put("lastUid", c.uid());
    device.put("lastUserName", c.name());
    device.put("lastSeenMillis", now);
    Object battery = d.raw("batteryPct");
    device.put("batteryPct", battery instanceof Number n ? Math.max(0, Math.min(100, Math.round(n.doubleValue()))) : null);
    device.put("charging", d.raw("charging") instanceof Boolean bool ? bool : null);
    device.put("firstSeenMillis", existing != null ? existing.get("firstSeenMillis") : now);
    device.put("lastLocation", lastLocation);
    device.put("trail", trail);
    store.set(b, "devices", id, device);

    if (existing == null) {
      audit.record(c, "device.firstSeen", "devices", id, Map.of("label", label, "status", status));
      if (isStaff && settings.flag("devices", "lockToApproved")) {
        notifier.notify(b, settings, Notifier.alert("newDevice", "warning", "New device waiting for approval: " + label)
            .message(c.name() + " tried to sign in on a device that is not approved (code " + code + ").")
            .detail("Device", label + " (code " + code + ")")
            .detail("Used by", c.name())
            .detail("When", Days.localTime(Instant.ofEpochMilli(now), settings.timezone()))
            .actor(c.name())
            .action("If it's a shop device, approve it under Devices. If it's someone's personal phone, block it.")
            .link("/devices"), "device_" + id);
      }
    }

    if (isStaff) {
      Map<String, Object> me = new LinkedHashMap<>();
      me.put("deviceId", id);
      me.put("deviceOkUntil", "approved".equals(status) ? Ts.of(now + DEVICE_OK_HOURS * 3_600_000L) : null);
      store.update(b, Store.EMPLOYEES, c.uid(), me);
      // away time: only the part inside today's trading hours counts, never the same stretch twice
      List<Map<String, Object>> oldSpans = activity == null ? List.of() : Domain.list(activity.get("spans"));
      Set<Long> seen = new java.util.HashSet<>();
      oldSpans.forEach(s -> seen.add(cents(s.get("from"))));
      List<Map<String, Object>> fresh = new ArrayList<>();
      List<Object> raw = d.list("spans");
      for (Object o : raw.subList(0, Math.min(raw.size(), 50))) {
        if (!(o instanceof Map<?, ?> m) || !(m.get("from") instanceof Number f) || !(m.get("to") instanceof Number t)) continue;
        long from = f.longValue();
        long to = t.longValue();
        if (!(to > from) || to > now + 60_000 || from < now - 24 * 3_600_000L) continue;
        Devices.Span clipped = Devices.clipSpan(new Devices.Span(from, to), open, close);
        if (clipped == null || seen.contains(clipped.from())) continue;
        fresh.add(Map.of("from", clipped.from(), "to", clipped.to()));
      }
      long before = activity == null ? 0 : cents(activity.get("awayMs"));
      long after = before + fresh.stream().mapToLong(s -> cents(s.get("to")) - cents(s.get("from"))).sum();
      List<Map<String, Object>> spans = new ArrayList<>(oldSpans);
      spans.addAll(fresh);
      if (spans.size() > Devices.MAX_SPANS_KEPT) spans = spans.subList(spans.size() - Devices.MAX_SPANS_KEPT, spans.size());
      Map<String, Object> act = new LinkedHashMap<>();
      act.put("uid", c.uid());
      act.put("name", c.name());
      act.put("dayKey", dayKey);
      act.put("awayMs", after);
      act.put("spans", spans);
      act.put("deviceId", id);
      act.put("deviceLabel", label);
      act.put("lastSeenMillis", now);
      store.set(b, "activity", activityId, act);

      long limit = Math.round(settings.number("devices", "awayAlertMinutes", 60)) * 60_000L;
      if (limit > 0 && before < limit && after >= limit) {
        notifier.notify(b, settings, Notifier.alert("awayTime", "warning", c.name() + ": Kota House off screen for " + Devices.formatDuration(after) + " today")
            .message("During trading hours today Kota House was not on screen for " + Devices.formatDuration(after) + " on " + c.name() + "'s device.")
            .detail("Worker", c.name())
            .detail("Not on screen today", Devices.formatDuration(after), "warn")
            .detail("Times away", String.valueOf(spans.size()))
            .detail("Device", label)
            .detail("Your limit", Math.round(settings.number("devices", "awayAlertMinutes", 60)) + " min a day")
            .actor("System check")
            .action("This means another app was open OR the screen was off. Look at the timeline under Devices and compare with sales at those times.")
            .link("/devices"), "away_" + c.uid() + "_" + dayKey);
      }
    }
    return Map.of("status", status, "code", code, "shareLocation", shareLocation);
  }

  @Operation(summary = "Approve, block or rename a device", description = "Owner only. Blocking stops every till action from that device straight away.")
  @PostMapping("/setDevice")
  @Transactional
  public Map<String, Object> setDevice(@AuthenticationPrincipal Jwt jwt, @RequestBody Map<String, Object> data) {
    Body d = Body.of(data);
    Caller owner = ctx.require(jwt, d, "owner");
    String id = deviceId(d);
    String b = owner.businessId();
    store.getForUpdate(b, "devices", id).orElseThrow(() -> ApiException.notFound("Device not found"));
    Map<String, Object> changes = new LinkedHashMap<>();
    String status = d.has("status") ? d.str("status") : null;
    if (status != null) {
      if (!Set.of("approved", "blocked", "pending").contains(status)) throw ApiException.invalid("Invalid status");
      changes.put("status", status);
    }
    if (d.has("label")) changes.put("label", d.text("label", "Device name", 2, 40));
    if (!changes.isEmpty()) store.update(b, "devices", id, changes);
    // a blocked device stops working straight away for everyone who used it
    if ("blocked".equals(status)) {
      for (var e : store.list(b, za.co.kotahouse.store.Query.of(Store.EMPLOYEES).where("deviceId", "==", id).build())) {
        Map<String, Object> clear = new LinkedHashMap<>();
        clear.put("deviceOkUntil", null);
        store.update(b, Store.EMPLOYEES, str(e.get("uid")), clear);
      }
    }
    audit.record(owner, "device." + (status != null ? status : "renamed"), "devices", id, changes);
    return Map.of("ok", true);
  }

  @Operation(summary = "Create a pairing code for a new shop device", description = "Owner only. A 6-digit code, valid for 24 hours, usable once.")
  @PostMapping("/createDeviceInvite")
  @Transactional
  public Map<String, Object> createDeviceInvite(@AuthenticationPrincipal Jwt jwt, @RequestBody Map<String, Object> data) {
    Body d = Body.of(data);
    Caller owner = ctx.require(jwt, d, "owner");
    String label = d.text("label", "Device name", 2, 40);
    long expires = System.currentTimeMillis() + Devices.INVITE_HOURS * 3_600_000L;
    for (int attempt = 0; attempt < 10; attempt++) {
      String code = String.valueOf(100000 + RANDOM.nextInt(900000));
      if (store.get(owner.businessId(), "deviceInvites", code).isPresent()) continue;
      Map<String, Object> invite = new LinkedHashMap<>();
      invite.put("code", code);
      invite.put("label", label);
      invite.put("createdBy", owner.uid());
      invite.put("expiresAtMillis", expires);
      invite.put("usedByDevice", null);
      store.create(owner.businessId(), "deviceInvites", code, invite);
      return Map.of("code", code, "expiresAtMillis", expires);
    }
    throw ApiException.precondition("Could not create a code, please try again");
  }

  @Operation(summary = "Pair this device with the owner's code", description = "The device is approved straight away. A code can't unblock a device the owner blocked.")
  @PostMapping("/pairDevice")
  @Transactional
  public Map<String, Object> pairDevice(@AuthenticationPrincipal Jwt jwt, @RequestBody Map<String, Object> data) {
    Body d = Body.of(data);
    Caller c = ctx.require(jwt, d, Ctx.Options.SKIP_BOTH, "owner", "employee", "kitchen");
    String id = deviceId(d);
    String code = d.str("code").replaceAll("\\D", "");
    if (code.length() != 6) throw ApiException.invalid("Enter the 6-digit code from the owner");
    String b = c.businessId();
    Map<String, Object> invite = store.getForUpdate(b, "deviceInvites", code).orElse(null);
    if (invite == null || invite.get("usedByDevice") != null || cents(invite.get("expiresAtMillis")) < System.currentTimeMillis()) {
      throw ApiException.notFound("That code is wrong or has expired – ask the owner for a new one");
    }
    Map<String, Object> existing = store.getForUpdate(b, "devices", id).orElse(null);
    if (existing != null && "blocked".equals(existing.get("status"))) throw ApiException.denied("The owner has blocked this device – a code cannot unblock it");
    long now = System.currentTimeMillis();
    String ua = d.str("userAgent");
    Map<String, Object> device = new LinkedHashMap<>(existing == null ? Map.of() : existing);
    device.put("label", invite.get("label"));
    device.put("code", code(id));
    device.put("userAgent", ua.length() > 300 ? ua.substring(0, 300) : ua);
    device.put("status", "approved");
    device.put("lastUid", c.uid());
    device.put("lastUserName", c.name());
    device.put("lastSeenMillis", now);
    device.put("firstSeenMillis", existing != null ? existing.get("firstSeenMillis") : now);
    store.set(b, "devices", id, device);
    store.update(b, "deviceInvites", code, Map.of("usedByDevice", id));
    if (!c.isOwner()) store.update(b, Store.EMPLOYEES, c.uid(), Map.of("deviceId", id, "deviceOkUntil", Ts.of(now + DEVICE_OK_HOURS * 3_600_000L)));
    audit.record(c, "device.paired", "devices", id, Map.of("label", invite.get("label")));
    return Map.of("status", "approved", "label", invite.get("label"));
  }
}
