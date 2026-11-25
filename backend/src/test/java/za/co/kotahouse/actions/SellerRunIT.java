package za.co.kotahouse.actions;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import za.co.kotahouse.ApiTestBase;
import za.co.kotahouse.domain.Domain;
import za.co.kotahouse.store.Query;
import za.co.kotahouse.store.Store;

/** A mobile seller takes kotas out (stock drops), then is reconciled on return (stock returns, shortfall flagged). */
class SellerRunIT extends ApiTestBase {
  @Autowired
  Store store;

  private Res rpc(TestShop s, Person p, String name, Map<String, Object> data) {
    Map<String, Object> m = new HashMap<>(data);
    m.put("businessId", s.businessId());
    return post("/api/rpc/" + name, p.token(), m);
  }

  private static Map<String, Object> write(String collection, String id, Map<String, Object> data) {
    Map<String, Object> w = new HashMap<>();
    w.put("collection", collection);
    if (id != null) w.put("id", id);
    w.put("data", data);
    return w;
  }

  @Test
  void sellerTakesKotasOutAndIsReconciledOnReturn() {
    TestShop s = newShop();
    Person cashier = addStaff(s, "employee", "Lindi");
    Person chef = addStaff(s, "kitchen", "Mandla");
    String b = s.businessId();
    String product = "sell234567890abcdefa";

    String bread = rpc(s, s.owner(), "saveCatalog", body("writes", List.of(write("ingredients", null,
        Map.of("name", "Bread", "unit", "each", "unitCostCents", 450, "openingQty", 20, "reorderLevel", 5, "active", true))))).<List<String>>get("ids").get(0);
    rpc(s, s.owner(), "saveCatalog", body("writes", List.of(
        write("products", product, Map.of("name", "Basic Kota", "category", "kota", "priceCents", 3500, "active", true, "sortOrder", 1)),
        write("recipes", product, Map.of("lines", List.of(Map.of("ingredientId", bread, "quantity", 1)))))));

    // the kitchen can't hand out a run; a cashier can
    assertThat(rpc(s, chef, "issueSellerRun", body("sellerName", "Thabo",
        "lines", List.of(Map.of("productId", product, "quantity", 10)))).status()).isEqualTo(403);

    Res out = rpc(s, cashier, "issueSellerRun", body("sellerName", "Thabo", "sellerPhone", "082 123 4567",
        "lines", List.of(Map.of("productId", product, "quantity", 10))));
    assertThat(out.status()).isEqualTo(200);
    String runId = out.get("runId");

    // 10 kotas out = 10 bread out of stock; the run records the selling value
    assertThat(Domain.num(store.get(b, "ingredients", bread).orElseThrow().get("currentQty"))).isEqualTo(10);
    var run = store.get(b, "sellerRuns", runId).orElseThrow();
    assertThat(run).containsEntry("status", "out").containsEntry("sellerName", "Thabo").containsEntry("sellerPhone", "27821234567");
    assertThat(Domain.cents(run.get("takenValueCents"))).isEqualTo(35000);

    // can't return more than went out
    assertThat(rpc(s, cashier, "settleSellerRun", body("runId", runId,
        "returns", List.of(Map.of("productId", product, "returnedQty", 11)), "cashReceivedCents", 0)).status()).isEqualTo(400);

    // return 3, hand in R200: sold 7 (R245), so R45 short; the 3 returned kotas go back into stock
    Res settled = rpc(s, cashier, "settleSellerRun", body("runId", runId,
        "returns", List.of(Map.of("productId", product, "returnedQty", 3)), "cashReceivedCents", 20000));
    assertThat(settled.status()).isEqualTo(200);
    assertThat(Domain.cents(settled.get("soldValueCents"))).isEqualTo(24500);
    assertThat(Domain.cents(settled.get("shortfallCents"))).isEqualTo(4500);
    assertThat(Domain.num(store.get(b, "ingredients", bread).orElseThrow().get("currentQty"))).isEqualTo(13);

    var done = store.get(b, "sellerRuns", runId).orElseThrow();
    assertThat(done).containsEntry("status", "settled");
    assertThat(Domain.list(done.get("lines"))).singleElement().satisfies(l -> {
      assertThat(Domain.num(l.get("returnedQty"))).isEqualTo(3);
      assertThat(Domain.num(l.get("soldQty"))).isEqualTo(7);
    });

    // the shortfall is over the alert threshold, so the owner is told; it can't be settled twice
    assertThat(store.list(b, Query.of("notifications").build()).stream().map(n -> String.valueOf(n.get("title"))))
        .anyMatch(t -> t.contains("Seller short"));
    assertThat(rpc(s, cashier, "settleSellerRun", body("runId", runId,
        "returns", List.of(), "cashReceivedCents", 0)).status()).isEqualTo(409);

    // both ends are in the activity log
    var actions = store.list(b, Query.of("auditLogs").build()).stream().map(a -> a.get("action")).toList();
    assertThat(actions).contains("seller.issued", "seller.settled");
  }
}
