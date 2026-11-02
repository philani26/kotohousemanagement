package za.co.kotahouse.actions;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.transaction.support.TransactionTemplate;
import za.co.kotahouse.ApiTestBase;
import za.co.kotahouse.domain.Domain;
import za.co.kotahouse.store.Query;
import za.co.kotahouse.store.Store;

/** The owner's menu/settings edits and the order queue, which the app used to write straight to Firestore. */
class CatalogAndOrdersIT extends ApiTestBase {
  @Autowired
  Store store;

  @Autowired
  TransactionTemplate tx;

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
  void ownerEditsTheMenuStockItemsAndSettings() {
    TestShop s = newShop();
    Person cashier = addStaff(s, "employee", "Sipho");
    String b = s.businessId();

    // a new ingredient with opening stock, then a product with its recipe, saved together
    Res ing = rpc(s, s.owner(), "saveCatalog", body("writes", List.of(write("ingredients", null,
        Map.of("name", "Bread", "unit", "each", "unitCostCents", 450, "openingQty", 20, "reorderLevel", 5, "active", true)))));
    assertThat(ing.status()).isEqualTo(200);
    String bread = ing.<List<String>>get("ids").get(0);
    assertThat(Domain.num(store.get(b, "ingredients", bread).orElseThrow().get("currentQty"))).isEqualTo(20);
    assertThat(store.list(b, Query.of("stockMovements").where("type", "==", "opening").build())).singleElement()
        .satisfies(m -> assertThat(Domain.cents(m.get("valueCents"))).isEqualTo(9000));

    Res prod = rpc(s, s.owner(), "saveCatalog", body("writes", List.of(
        write("products", "kota1234567890abcdef", Map.of("name", "Basic Kota", "category", "kota", "priceCents", 3500, "active", true, "sortOrder", 1)),
        write("recipes", "kota1234567890abcdef", Map.of("lines", List.of(Map.of("ingredientId", bread, "quantity", 1)))))));
    assertThat(prod.status()).isEqualTo(200);
    assertThat(store.get(b, "recipes", "kota1234567890abcdef").orElseThrow()).containsEntry("productId", "kota1234567890abcdef");

    // stock can't be changed by editing the item, and bad data is refused
    rpc(s, s.owner(), "saveCatalog", body("writes", List.of(write("ingredients", bread, Map.of("currentQty", 999, "unitCostCents", 500)))));
    assertThat(Domain.num(store.get(b, "ingredients", bread).orElseThrow().get("currentQty"))).isEqualTo(20);
    assertThat(rpc(s, s.owner(), "saveCatalog", body("writes", List.of(write("products", null, Map.of("name", "", "category", "kota", "priceCents", 1, "active", true))))).status())
        .isEqualTo(400);
    // all or nothing: one bad record and nothing is saved
    assertThat(rpc(s, s.owner(), "saveCatalog", body("writes", List.of(
        write("suppliers", "sup1234567890abcdefg", Map.of("name", "Bakery")),
        write("products", null, Map.of("name", "Bad", "category", "kota", "priceCents", -1, "active", true))))).status()).isEqualTo(400);
    assertThat(store.get(b, "suppliers", "sup1234567890abcdefg")).isEmpty();

    // settings are merged and checked; server-only parts can't be set
    assertThat(rpc(s, s.owner(), "saveCatalog", body("writes", List.of(write("businessSettings", null,
        Map.of("maxEmployeeDiscountPercent", 10, "yoco", Map.of("enabled", true)))))).status()).isEqualTo(200);
    var settings = store.get(b, "businessSettings", "main").orElseThrow();
    assertThat(settings).containsEntry("maxEmployeeDiscountPercent", 10).containsEntry("businessName", "Test Kota");
    assertThat(settings.get("yoco")).isNotEqualTo(Map.of("enabled", true));
    assertThat(rpc(s, s.owner(), "saveCatalog", body("writes", List.of(write("businessSettings", null, Map.of("maxEmployeeDiscountPercent", 150))))).status()).isEqualTo(400);

    // only the owner edits the menu
    assertThat(rpc(s, cashier, "saveCatalog", body("writes", List.of(write("suppliers", null, Map.of("name", "X"))))).status()).isEqualTo(403);

    // every change is in the activity log, by field
    var actions = store.list(b, Query.of("auditLogs").build()).stream().map(a -> a.get("action")).toList();
    assertThat(actions).contains("ingredients.created", "products.created", "recipes.created", "ingredients.updated", "businessSettings.updated");
  }

  @Test
  void alertsCanBeMarkedRead() {
    TestShop s = newShop();
    String b = s.businessId();
    tx.executeWithoutResult(t -> {
      store.set(b, "notifications", "n1aaaaaaaaaaaaaaaaaa", Map.of("read", false, "title", "A"));
      store.set(b, "notifications", "n2aaaaaaaaaaaaaaaaaa", Map.of("read", false, "title", "B"));
    });
    rpc(s, s.owner(), "markNotificationsRead", body("ids", List.of("n1aaaaaaaaaaaaaaaaaa")));
    assertThat(store.get(b, "notifications", "n1aaaaaaaaaaaaaaaaaa").orElseThrow().get("read")).isEqualTo(true);
    assertThat(store.get(b, "notifications", "n2aaaaaaaaaaaaaaaaaa").orElseThrow().get("read")).isEqualTo(false);
    rpc(s, s.owner(), "markNotificationsRead", body("all", true));
    assertThat(store.get(b, "notifications", "n2aaaaaaaaaaaaaaaaaa").orElseThrow().get("read")).isEqualTo(true);
  }

  @Test
  void theOrderQueueMovesAndTheKitchenCantHandOverUnpaidWhatsAppOrders() {
    TestShop s = newShop();
    Person cashier = addStaff(s, "employee", "Sipho");
    Person chef = addStaff(s, "kitchen", "Mandla");
    String b = s.businessId();
    String id = "sale1234567890abcdefgh";

    Map<String, Object> ticket = body("orderId", id, "lines", List.of(Map.of("name", "Basic Kota", "quantity", 2)), "note", "no atchar", "receiptNo", 7);
    assertThat(rpc(s, cashier, "createOrder", ticket).<Boolean>get("duplicate")).isFalse();
    assertThat(rpc(s, cashier, "createOrder", ticket).<Boolean>get("duplicate")).isTrue(); // retried: still one ticket
    assertThat(rpc(s, chef, "createOrder", body("orderId", "other1234567890abcdef", "lines", List.of(Map.of("name", "x", "quantity", 1)))).status()).isEqualTo(403);

    assertThat(rpc(s, chef, "setOrderStatus", body("orderId", id, "status", "preparing")).status()).isEqualTo(200);
    assertThat(rpc(s, chef, "setOrderStatus", body("orderId", id, "status", "ready")).status()).isEqualTo(200);
    var order = store.get(b, "orders", id).orElseThrow();
    assertThat(order).containsEntry("status", "ready").containsKeys("preparingAt", "readyAt");

    // an unpaid WhatsApp order
    tx.executeWithoutResult(t -> store.set(b, "orders", "wa12345678901234567", Map.of("status", "ready", "source", "whatsapp", "paid", false, "lines", List.of())));
    assertThat(rpc(s, chef, "setOrderStatus", body("orderId", "wa12345678901234567", "status", "collected")).status()).isEqualTo(403);
    rpc(s, cashier, "linkOrderSale", body("orderId", "wa12345678901234567", "paid", true, "saleId", id, "receiptNo", 8));
    assertThat(rpc(s, chef, "setOrderStatus", body("orderId", "wa12345678901234567", "status", "collected")).status()).isEqualTo(200);

    // linking a sale without a ticket (only extras) is fine
    assertThat(rpc(s, cashier, "linkOrderSale", body("orderId", "noticket1234567890ab", "receiptNo", 9)).<Boolean>get("found")).isFalse();
  }
}
