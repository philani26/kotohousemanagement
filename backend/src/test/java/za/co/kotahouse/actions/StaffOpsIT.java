package za.co.kotahouse.actions;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.transaction.support.TransactionTemplate;
import za.co.kotahouse.ApiTestBase;
import za.co.kotahouse.domain.Domain;
import za.co.kotahouse.store.Query;
import za.co.kotahouse.store.Store;

/** Work-site check, shop devices and the time clock (the scenarios of day-flow.spec.ts). */
class StaffOpsIT extends ApiTestBase {
  @Autowired
  Store store;

  @Autowired
  TransactionTemplate tx;

  private Res rpc(TestShop s, Person p, String name, Map<String, Object> data) {
    Map<String, Object> m = new HashMap<>(data);
    m.put("businessId", s.businessId());
    return post("/api/rpc/" + name, p.token(), m);
  }

  private void settings(TestShop s, Map<String, Object> changes) {
    tx.executeWithoutResult(t -> store.merge(s.businessId(), "businessSettings", "main", changes));
  }

  @Test
  void staffOnlyWorkAfterCheckingInAtTheShop() {
    TestShop s = newShop();
    Person cashier = addStaff(s, "employee", "Sipho");
    double lat = -26.2485;
    double lng = 27.854;
    settings(s, Map.of("geofence", Map.of("enabled", true, "lat", lat, "lng", lng, "radiusM", 150)));

    assertThat(rpc(s, cashier, "openShift", body("openingFloatCents", 1000, "checklist", List.of())).<String>get("message")).contains("Check in at the shop first");

    Res far = rpc(s, cashier, "checkIn", body("lat", -26.1076, "lng", 28.0567, "accuracyM", 15)); // Sandton, ~25 km
    assertThat(far.<Boolean>get("ok")).isFalse();
    assertThat(far.<String>get("reason")).isEqualTo("outside");
    var alerts = store.list(s.businessId(), Query.of("notifications").where("type", "==", "siteBlocked").build());
    assertThat(alerts).singleElement().satisfies(a -> {
      assertThat((String) a.get("message")).contains("km from the shop");
      assertThat(a.toString()).doesNotContain("28.05"); // only the distance is kept, never the location
    });

    assertThat(rpc(s, cashier, "checkIn", body("lat", lat + 0.0004, "lng", lng, "accuracyM", 20)).<Boolean>get("ok")).isTrue();
    assertThat(rpc(s, cashier, "openShift", body("openingFloatCents", 1000, "checklist", List.of())).<String>get("shiftId")).isNotBlank();
    // owners are never blocked
    assertThat(rpc(s, s.owner(), "recordPayout", body("amountCents", 100, "reason", "owner test")).status()).isEqualTo(200);
  }

  @Test
  void staffOnlyWorkOnApprovedDevicesAndAwayTimeIsTracked() {
    TestShop s = newShop();
    Person cashier = addStaff(s, "employee", "Sipho");
    String b = s.businessId();
    rpc(s, cashier, "openShift", body("openingFloatCents", 1000, "checklist", List.of()));
    settings(s, Map.of("devices", Map.of("lockToApproved", true, "awayAlertMinutes", 30), "openingHour", 0, "closingHour", 24));
    String deviceId = "dev-" + UUID.randomUUID().toString().substring(0, 8) + "-abcdef1234";
    String ua = "Mozilla/5.0 (Linux; Android 14; SM-A146B Build/UP1A) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36";

    Res first = rpc(s, cashier, "deviceHeartbeat", body("deviceId", deviceId, "userAgent", ua, "batteryPct", 64, "charging", false));
    assertThat(first.<String>get("status")).isEqualTo("pending");
    assertThat(store.list(b, Query.of("notifications").where("type", "==", "newDevice").build())).hasSize(1);

    assertThat(rpc(s, cashier, "recordPayout", body("amountCents", 100, "reason", "test", "deviceId", deviceId)).<String>get("message")).contains("not an approved shop device");
    rpc(s, s.owner(), "setDevice", body("deviceId", deviceId, "status", "approved", "label", "Till phone"));
    assertThat(rpc(s, cashier, "recordPayout", body("amountCents", 100, "reason", "test", "deviceId", deviceId)).status()).isEqualTo(200);
    var dev = store.get(b, "devices", deviceId).orElseThrow();
    assertThat(dev).containsEntry("label", "Till phone").containsEntry("batteryPct", 64).containsEntry("lastUserName", "Sipho");

    // 35 minutes off screen, reported twice (a retry) – counted once, and over the 30 min limit
    long now = System.currentTimeMillis();
    Map<String, Object> span = Map.of("from", now - 40 * 60_000, "to", now - 5 * 60_000);
    rpc(s, cashier, "deviceHeartbeat", body("deviceId", deviceId, "userAgent", ua, "spans", List.of(span)));
    rpc(s, cashier, "deviceHeartbeat", body("deviceId", deviceId, "userAgent", ua, "spans", List.of(span)));
    var mine = store.list(b, Query.of("activity").where("name", "==", "Sipho").build()).get(0);
    assertThat(Math.round(Domain.cents(mine.get("awayMs")) / 60_000.0)).isEqualTo(35);
    assertThat(store.list(b, Query.of("notifications").where("type", "==", "awayTime").build())).hasSize(1);

    // location: only stored when the owner switched sharing on
    Map<String, Object> here = Map.of("lat", -26.2486, "lng", 27.8541, "accuracyM", 12);
    rpc(s, cashier, "deviceHeartbeat", body("deviceId", deviceId, "userAgent", ua, "location", here));
    assertThat(store.get(b, "devices", deviceId).orElseThrow().get("lastLocation")).isNull();
    settings(s, Map.of("devices", Map.of("lockToApproved", true, "awayAlertMinutes", 30, "shareLocation", true)));
    assertThat(rpc(s, cashier, "deviceHeartbeat", body("deviceId", deviceId, "userAgent", ua, "location", here)).<Boolean>get("shareLocation")).isTrue();
    var located = store.get(b, "devices", deviceId).orElseThrow();
    assertThat(Domain.map(located.get("lastLocation"))).containsEntry("lat", -26.2486).containsEntry("lng", 27.8541).containsEntry("accuracyM", 12);
    assertThat(Domain.list(located.get("trail"))).hasSize(1);

    // pairing: the owner makes a code, a new phone enters it and is approved straight away
    Res invite = rpc(s, s.owner(), "createDeviceInvite", body("label", "Kitchen tablet"));
    assertThat(invite.<String>get("code")).matches("^\\d{6}$");
    String tabletId = "tab-" + UUID.randomUUID().toString().substring(0, 8) + "-abcdef1234";
    Res paired = rpc(s, cashier, "pairDevice", body("code", invite.get("code"), "deviceId", tabletId, "userAgent", ua));
    assertThat(paired.body()).isEqualTo(Map.of("status", "approved", "label", "Kitchen tablet"));
    assertThat(rpc(s, cashier, "pairDevice", body("code", invite.get("code"), "deviceId", "other-abcdef1234567", "userAgent", ua)).<String>get("message")).contains("wrong or has expired");
    assertThat(rpc(s, cashier, "recordPayout", body("amountCents", 100, "reason", "tablet", "deviceId", tabletId)).status()).isEqualTo(200);

    // blocking stops it again, and a pairing code can't unblock it
    rpc(s, s.owner(), "setDevice", body("deviceId", deviceId, "status", "blocked"));
    assertThat(rpc(s, cashier, "recordPayout", body("amountCents", 100, "reason", "test", "deviceId", deviceId)).<String>get("message")).contains("not an approved");
    String second = rpc(s, s.owner(), "createDeviceInvite", body("label", "Sneaky")).get("code");
    assertThat(rpc(s, cashier, "pairDevice", body("code", second, "deviceId", deviceId, "userAgent", ua)).<String>get("message")).contains("cannot unblock");
  }

  @Test
  void theTimeClock() {
    TestShop s = newShop();
    Person cashier = addStaff(s, "employee", "Sipho");
    Res first = rpc(s, cashier, "clockIn", body());
    assertThat(first.<Boolean>get("alreadyIn")).isFalse();
    assertThat(rpc(s, cashier, "clockIn", body()).<Boolean>get("alreadyIn")).isTrue();
    assertThat(rpc(s, cashier, "clockOut", body()).status()).isEqualTo(200);
    assertThat(rpc(s, cashier, "clockOut", body()).<String>get("message")).contains("not clocked in");
    assertThat(rpc(s, s.owner(), "clockIn", body()).<String>get("message")).contains("not allowed");

    // a forgotten clock-out: the owner sets it, with a reason
    Res second = rpc(s, cashier, "clockIn", body());
    String entryId = second.get("entryId");
    long in = ((Number) second.get("clockInMillis")).longValue();
    assertThat(rpc(s, cashier, "fixTimeEntry", body("entryId", entryId, "clockOutMillis", System.currentTimeMillis(), "reason", "left early")).status()).isEqualTo(403);
    assertThat(rpc(s, s.owner(), "fixTimeEntry", body("entryId", entryId, "clockOutMillis", in - 1000, "reason", "oops")).<String>get("message")).contains("after clock-in");
    assertThat(rpc(s, s.owner(), "fixTimeEntry", body("entryId", entryId, "clockOutMillis", System.currentTimeMillis(), "reason", "Forgot to clock out")).status()).isEqualTo(200);
    assertThat(store.get(s.businessId(), "timeEntries", entryId).orElseThrow()).containsEntry("fixReason", "Forgot to clock out");

    // staff only see their own entries
    Res mine = post("/api/shops/" + s.businessId() + "/query", cashier.token(), body("collection", "timeEntries"));
    assertThat(mine.list()).hasSize(2).allSatisfy(e -> assertThat(e.get("uid")).isEqualTo(cashier.uid()));
  }
}
