package za.co.kotahouse.store;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.transaction.support.TransactionTemplate;
import za.co.kotahouse.ApiTestBase;

/** The app's read access: permissions per role, query operations, record updates and live changes. */
class DataLayerIT extends ApiTestBase {
  @Autowired
  Store store;

  @Autowired
  TransactionTemplate tx;

  @LocalServerPort
  int localPort;

  private Res query(TestShop s, String token, Object body) {
    return post("/api/shops/" + s.businessId() + "/query", token, body);
  }

  private void put(TestShop s, String c, String id, Map<String, Object> data) {
    tx.executeWithoutResult(t -> store.set(s.businessId(), c, id, data));
  }

  @Test
  void eachRoleSeesOnlyWhatTheyMay() {
    TestShop s = newShop();
    Person cashier = addStaff(s, "employee", "Sipho");
    Person other = addStaff(s, "employee", "Lerato");
    Person chef = addStaff(s, "kitchen", "Mandla");
    put(s, "sales", "s1", Map.of("employeeId", cashier.uid(), "totalCents", 3500, "dayKey", "2026-11-01"));
    put(s, "sales", "s2", Map.of("employeeId", other.uid(), "totalCents", 4000, "dayKey", "2026-11-02"));
    put(s, "shifts", "open1", Map.of("employeeId", other.uid(), "status", "open"));
    put(s, "shifts", "old1", Map.of("employeeId", other.uid(), "status", "closed"));
    put(s, "orders", "o1", Map.of("status", "new", "dayKey", "2026-11-02"));
    put(s, "customers", "27825550001", Map.of("name", "Lerato", "stamps", 3));

    // settings exist from the start, with defaults
    Res settings = get("/api/shops/" + s.businessId() + "/data/businessSettings/main", chef.token());
    assertThat(settings.<String>get("businessName")).isEqualTo("Test Kota");
    assertThat(settings.<String>get("currency")).isEqualTo("ZAR");

    // owner: everything; cashier: own sales only
    assertThat(query(s, s.owner().token(), body("collection", "sales")).list()).hasSize(2);
    assertThat(query(s, cashier.token(), body("collection", "sales")).list()).extracting(m -> m.get("id")).containsExactly("s1");
    assertThat(get("/api/shops/" + s.businessId() + "/data/sales/s2", cashier.token()).status()).isEqualTo(403);

    // shifts: a cashier sees the open shift (single till) but not other people's closed ones
    assertThat(query(s, cashier.token(), body("collection", "shifts")).list()).extracting(m -> m.get("id")).containsExactly("open1");

    // kitchen: order queue only
    assertThat(query(s, chef.token(), body("collection", "orders")).list()).hasSize(1);
    assertThat(query(s, chef.token(), body("collection", "products")).status()).isEqualTo(403);
    assertThat(query(s, cashier.token(), body("collection", "cashSessions")).status()).isEqualTo(403);
    assertThat(query(s, cashier.token(), body("collection", "notSomethingWeHave")).status()).isEqualTo(403);

    // customers: a cashier may look up one number but not list everyone
    assertThat(get("/api/shops/" + s.businessId() + "/data/customers/27825550001", cashier.token()).<String>get("name")).isEqualTo("Lerato");
    assertThat(get("/api/shops/" + s.businessId() + "/data/customers/27820000000", cashier.token()).status()).isIn(200, 204);
    assertThat(query(s, cashier.token(), body("collection", "customers")).status()).isEqualTo(403);
    assertThat(query(s, s.owner().token(), body("collection", "customers")).list()).hasSize(1);

    // staff records come from the memberships table; staff see only their own
    assertThat(query(s, s.owner().token(), body("collection", "employees", "orderBy", List.of(List.of("displayName")))).list())
        .extracting(m -> m.get("displayName")).containsExactly("Lerato", "Mandla", "Sipho", "Thandi");
    assertThat(query(s, cashier.token(), body("collection", "employees")).list()).singleElement()
        .satisfies(m -> assertThat(m.get("uid")).isEqualTo(cashier.uid()));

    // another shop's people get nothing
    TestShop elsewhere = newShop();
    assertThat(query(s, elsewhere.owner().token(), body("collection", "sales")).status()).isEqualTo(403);
    assertThat(query(elsewhere, elsewhere.owner().token(), body("collection", "sales")).list()).isEmpty();
  }

  @Test
  void queriesFilterSortAndLimit() {
    TestShop s = newShop();
    String t = s.owner().token();
    for (int i = 1; i <= 5; i++) {
      put(s, "dailyStats", "2026-11-0" + i, Map.of("dayKey", "2026-11-0" + i, "orders", i, "createdAt", Ts.of(1_800_000_000_000L + i * 1000L)));
    }
    var range = query(s, t, body("collection", "dailyStats", "where", List.of(List.of("dayKey", ">=", "2026-11-02"), List.of("dayKey", "<=", "2026-11-04")),
        "orderBy", List.of(List.of("dayKey")))).list();
    assertThat(range).extracting(m -> m.get("dayKey")).containsExactly("2026-11-02", "2026-11-03", "2026-11-04");

    var in = query(s, t, body("collection", "dailyStats", "where", List.of(List.of("dayKey", "in", List.of("2026-11-01", "2026-11-05"))))).list();
    assertThat(in).hasSize(2);

    var newest = query(s, t, body("collection", "dailyStats", "orderBy", List.of(List.of("createdAt", "desc")), "limit", 2)).list();
    assertThat(newest).extracting(m -> m.get("orders")).containsExactly(5, 4);
    // timestamps come back as {"__ts": millis}
    assertThat(newest.get(0).get("createdAt")).isEqualTo(Map.of("__ts", 1_800_000_005_000L));

    var eq = query(s, t, body("collection", "dailyStats", "where", List.of(List.of("orders", "==", 3)))).list();
    assertThat(eq).singleElement().satisfies(m -> assertThat(m.get("dayKey")).isEqualTo("2026-11-03"));

    assertThat(query(s, t, body("collection", "dailyStats", "where", List.of(List.of("x;drop", "==", 1)))).status()).isEqualTo(400);
  }

  @Test
  void updatesWorkLikeFirestore() {
    TestShop s = newShop();
    String b = s.businessId();
    tx.executeWithoutResult(t -> {
      store.set(b, "cashSessions", "c1", Map.of("cashSalesCents", 100, "refund", Map.of("reason", "x")));
      store.update(b, "cashSessions", "c1", Map.of("cashSalesCents", Op.inc(250), "refund.decidedBy", "u1", "closedAt", Op.serverTime()));
      store.merge(b, "cashSessions", "c1", Map.of("refund", Map.of("note", "ok"), "cardSalesCents", Op.inc(50)));
      store.merge(b, "dailyStats", "2026-11-02", Map.of("byMethod", Map.of("cash", Op.inc(300))));
      store.merge(b, "dailyStats", "2026-11-02", Map.of("byMethod", Map.of("cash", Op.inc(200), "card", Op.inc(5))));
    });
    var c1 = store.get(b, "cashSessions", "c1").orElseThrow();
    assertThat(c1.get("cashSalesCents")).isEqualTo(350);
    assertThat(c1.get("cardSalesCents")).isEqualTo(50);
    assertThat(c1.get("refund")).isEqualTo(Map.of("reason", "x", "decidedBy", "u1", "note", "ok"));
    assertThat(Ts.is(c1.get("closedAt"))).isTrue();
    assertThat(store.get(b, "dailyStats", "2026-11-02").orElseThrow().get("byMethod")).isEqualTo(Map.of("cash", 500, "card", 5));

    // a rolled-back transaction leaves nothing behind
    try {
      tx.executeWithoutResult(t -> {
        store.set(b, "sales", "ghost", Map.of("totalCents", 1));
        throw new IllegalStateException("boom");
      });
    } catch (IllegalStateException expected) {
      // fine
    }
    assertThat(store.get(b, "sales", "ghost")).isEmpty();

    // staff extras (work-site check) go into the membership profile; core fields stay with the membership
    tx.executeWithoutResult(t -> store.update(b, "employees", s.owner().uid(), Map.of("siteCheckDistanceM", 42)));
    assertThat(store.get(b, "employees", s.owner().uid()).orElseThrow()).containsEntry("siteCheckDistanceM", 42).containsEntry("role", "owner");
  }

  @Test
  void screensHearAboutChangesAfterCommit() throws Exception {
    TestShop s = newShop();
    HttpRequest req = HttpRequest.newBuilder(URI.create("http://localhost:" + localPort + "/api/shops/" + s.businessId() + "/events"))
        .header("Authorization", "Bearer " + s.owner().token()).header("Accept", "text/event-stream").build();
    HttpResponse<java.io.InputStream> res = HttpClient.newHttpClient().send(req, HttpResponse.BodyHandlers.ofInputStream());
    assertThat(res.statusCode()).isEqualTo(200);
    BufferedReader lines = new BufferedReader(new InputStreamReader(res.body()));
    CompletableFuture<String> changed = CompletableFuture.supplyAsync(() -> {
      try {
        String line;
        String event = null;
        while ((line = lines.readLine()) != null) {
          if (line.startsWith("event:")) event = line.substring(6).trim();
          else if (line.startsWith("data:") && "changed".equals(event)) return line.substring(5).trim();
        }
      } catch (Exception e) {
        throw new RuntimeException(e);
      }
      return null;
    });
    Thread.sleep(300); // let the subscription register
    put(s, "orders", "o1", Map.of("status", "new"));
    assertThat(changed.get(10, TimeUnit.SECONDS)).contains("orders");
    res.body().close();

    // without a token: refused
    HttpResponse<String> anon = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()
        .send(HttpRequest.newBuilder(URI.create("http://localhost:" + localPort + "/api/shops/" + s.businessId() + "/events")).build(),
            HttpResponse.BodyHandlers.ofString());
    assertThat(anon.statusCode()).isEqualTo(401);
  }
}
