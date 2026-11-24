package za.co.kotahouse.cards;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.transaction.support.TransactionTemplate;
import za.co.kotahouse.ApiTestBase;
import za.co.kotahouse.actions.MonitorJob;
import za.co.kotahouse.domain.Domain;
import za.co.kotahouse.store.Query;
import za.co.kotahouse.store.Store;

/** Card machines of any provider: upload, live push, automatic and manual matching. */
class CardsIT extends ApiTestBase {
  private static final long MIN = 60_000;

  @Autowired
  Store store;

  @Autowired
  TransactionTemplate tx;

  @Autowired
  MonitorJob monitor;

  private Res rpc(TestShop s, Person p, String name, Map<String, Object> data) {
    Map<String, Object> m = new HashMap<>(data);
    m.put("businessId", s.businessId());
    return post("/api/rpc/" + name, p.token(), m);
  }

  private String sell(TestShop s, Person p, String product, Map<String, Object> payment, long soldAt) {
    String id = "sale" + UUID.randomUUID().toString().replace("-", "").substring(0, 16);
    Res r = rpc(s, p, "recordSale", body("saleId", id, "items", List.of(Map.of("productId", product, "quantity", 1)), "payment", payment, "soldAtMillis", soldAt));
    assertThat(r.status()).as(String.valueOf(r.body())).isEqualTo(200);
    return id;
  }

  private Map<String, Object> pay(TestShop s, String saleId) {
    return Domain.map(store.get(s.businessId(), "sales", saleId).orElseThrow().get("payment"));
  }

  private static Map<String, Object> row(long at, long cents, String ref, String status) {
    Map<String, Object> r = new HashMap<>();
    r.put("atMillis", at);
    r.put("amountCents", cents);
    if (ref != null) r.put("reference", ref);
    if (status != null) r.put("status", status);
    return r;
  }

  @Test
  void uploadsFromAnyProviderAreMatchedToCardSales() {
    TestShop s = newShop();
    Person cashier = addStaff(s, "employee", "Sipho");
    String b = s.businessId();
    rpc(s, cashier, "openShift", body("openingFloatCents", 0, "checklist", List.of()));
    String kota = store.newId();
    String big = store.newId();
    tx.executeWithoutResult(t -> {
      store.set(b, "products", kota, Map.of("name", "Basic Kota", "category", "kota", "priceCents", 3500, "active", true, "sortOrder", 1));
      store.set(b, "products", big, Map.of("name", "Family Kota", "category", "kota", "priceCents", 8000, "active", true, "sortOrder", 2));
    });
    long now = System.currentTimeMillis();
    String card1 = sell(s, cashier, kota, Map.of("method", "card"), now - 50 * MIN);
    String card2 = sell(s, cashier, kota, Map.of("method", "card"), now - 40 * MIN);
    String split = sell(s, cashier, big, Map.of("method", "card", "cashCents", 5000, "amountReceivedCents", 5000), now - 30 * MIN);
    String cash = sell(s, cashier, kota, Map.of("method", "cash", "amountReceivedCents", 3500), now - 20 * MIN);

    List<Map<String, Object>> rows = List.of(
        row(now - 49 * MIN, 3500, "AUTH111", "Approved"),
        row(now - 41 * MIN, 3500, "AUTH222", "Approved"),
        row(now - 29 * MIN, 3000, "AUTH333", "APPROVED"),      // the card part of the split sale
        row(now - 25 * MIN, 3500, "AUTH444", "Declined"),      // declined: never matches
        row(now - 35 * MIN, 4000, "AUTH555", "Approved"));     // money taken, no sale
    // only the owner imports
    assertThat(rpc(s, cashier, "importCardTransactions", body("provider", "iKhokha", "rows", rows)).status()).isEqualTo(403);
    Res r = rpc(s, s.owner(), "importCardTransactions", body("provider", "iKhokha", "rows", rows));
    assertThat(r.body()).containsEntry("added", 5).containsEntry("matched", 3).containsEntry("unmatched", 1);

    assertThat(pay(s, card1)).containsEntry("verified", true).containsEntry("reference", "AUTH111").containsEntry("verifiedBy", "card:iKhokha");
    assertThat(pay(s, card2)).containsEntry("reference", "AUTH222");
    assertThat(pay(s, split)).containsEntry("verified", true).containsEntry("reference", "AUTH333");
    assertThat(pay(s, cash)).doesNotContainKey("cardTxnId");
    // the unexplained R40 is flagged to the owner
    assertThat(store.list(b, Query.of("notifications").where("type", "==", "cardUnmatched").build())).singleElement()
        .satisfies(n -> assertThat(String.valueOf(n.get("title"))).contains("1 card payment with no sale"));

    // the same file again changes nothing
    assertThat(rpc(s, s.owner(), "importCardTransactions", body("provider", "iKhokha", "rows", rows)).body()).containsEntry("added", 0).containsEntry("duplicates", 5);

    // the owner matches by hand; wrong amounts are refused; undo works
    String noSale = store.list(b, Query.of(CardService.COLLECTION).where("reference", "==", "AUTH555").build()).get(0).get("id").toString();
    assertThat(rpc(s, s.owner(), "matchCardTransaction", body("transactionId", noSale, "saleId", cash)).status()).isEqualTo(400);
    String t1 = store.list(b, Query.of(CardService.COLLECTION).where("reference", "==", "AUTH111").build()).get(0).get("id").toString();
    assertThat(rpc(s, s.owner(), "matchCardTransaction", body("transactionId", t1)).status()).isEqualTo(200);
    assertThat(pay(s, card1)).containsEntry("verified", false).doesNotContainKey("cardTxnId");
    assertThat(rpc(s, s.owner(), "matchCardTransaction", body("transactionId", t1, "saleId", card1)).status()).isEqualTo(200);
    assertThat(pay(s, card1)).containsEntry("verified", true);

    // cashiers can't see the machine's transactions
    assertThat(post("/api/shops/" + b + "/query", cashier.token(), body("collection", "cardTransactions")).status()).isEqualTo(403);
  }

  @Test
  void providersCanPushPaymentsLiveEvenBeforeTheSaleIsRungUp() {
    TestShop s = newShop();
    String b = s.businessId();
    rpc(s, s.owner(), "openShift", body("openingFloatCents", 0, "checklist", List.of()));
    String kota = store.newId();
    tx.executeWithoutResult(t -> store.set(b, "products", kota, Map.of("name", "Basic Kota", "category", "kota", "priceCents", 3500, "active", true, "sortOrder", 1)));

    Res hook = rpc(s, s.owner(), "cardWebhook", body());
    String url = hook.get("url");
    String token = hook.get("token");
    String path = url.substring(url.indexOf("/api/webhooks/cards/"));

    // wrong secret: refused
    Res bad = call(org.springframework.http.HttpMethod.POST, path, null, body("provider", "Yoco", "transactions", List.of()));
    assertThat(bad.status()).isEqualTo(403);

    // the machine reports the payment first (ISO time, amount in rand, as Zapier/Make send it)
    long now = System.currentTimeMillis();
    String iso = java.time.Instant.ofEpochMilli(now - 2 * MIN).toString();
    Res pushed = http.post().uri(path).header("X-Card-Token", token).contentType(org.springframework.http.MediaType.APPLICATION_JSON)
        .body(body("provider", "Yoco", "transactions", List.of(Map.of("at", iso, "amount", "35.00", "reference", "YOCO-1"))))
        .exchange((rq, rs) -> new Res(rs.getStatusCode().value(), null, null));
    assertThat(pushed.status()).isEqualTo(200);

    // ...then the cashier rings up the sale; the next 15-minute check pairs them
    String sale = sell(s, s.owner(), kota, Map.of("method", "card"), now - MIN);
    assertThat(pay(s, sale)).doesNotContainKey("cardTxnId");
    monitor.run();
    assertThat(pay(s, sale)).containsEntry("verified", true).containsEntry("reference", "YOCO-1");

    // renewing the secret stops the old one
    rpc(s, s.owner(), "cardWebhook", body("renew", true));
    Res old = http.post().uri(path).header("X-Card-Token", token).contentType(org.springframework.http.MediaType.APPLICATION_JSON)
        .body(body("provider", "Yoco", "transactions", List.of())).exchange((rq, rs) -> new Res(rs.getStatusCode().value(), null, null));
    assertThat(old.status()).isEqualTo(403);
  }
}
