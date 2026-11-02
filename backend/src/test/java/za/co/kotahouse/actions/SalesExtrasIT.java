package za.co.kotahouse.actions;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.transaction.support.TransactionTemplate;
import za.co.kotahouse.ApiTestBase;
import za.co.kotahouse.domain.Domain;
import za.co.kotahouse.store.Query;
import za.co.kotahouse.store.Store;

/** Split payments, the stamp card, Yoco card-on-phone, WhatsApp orders and the 15-minute checks. */
class SalesExtrasIT extends ApiTestBase {
  @Autowired
  Store store;

  @Autowired
  TransactionTemplate tx;

  @Autowired
  MonitorJob monitor;

  @LocalServerPort
  int localPort;

  private Res rpc(TestShop s, Person p, String name, Map<String, Object> data) {
    Map<String, Object> m = new HashMap<>(data);
    m.put("businessId", s.businessId());
    return post("/api/rpc/" + name, p.token(), m);
  }

  private String product(TestShop s, String name, long price) {
    String id = store.newId();
    tx.executeWithoutResult(t -> store.set(s.businessId(), "products", id, Map.of("name", name, "category", "kota", "priceCents", price, "active", true, "sortOrder", 1)));
    return id;
  }

  private static String saleId(String prefix) {
    return prefix + UUID.randomUUID().toString().replace("-", "").substring(0, 16);
  }

  private Map<String, Object> openSession(TestShop s) {
    return store.list(s.businessId(), Query.of("cashSessions").where("status", "==", "open").build()).get(0);
  }

  @Test
  void splitsAPaymentBetweenCashAndCardAndRefundsOnlyTheCashFromTheTill() {
    TestShop s = newShop();
    rpc(s, s.owner(), "openShift", body("openingFloatCents", 10000, "checklist", List.of()));
    String kota = product(s, "Family Kota", 8000);
    String id = saleId("split");
    var items = List.of(Map.of("productId", kota, "quantity", 1));
    // R80: R50 cash, the rest (R30) on the card machine
    assertThat(rpc(s, s.owner(), "recordSale", body("saleId", id, "items", items, "payment", Map.of("method", "card", "cashCents", 5000, "amountReceivedCents", 4000)))
        .<String>get("message")).contains("cash part");
    Res res = rpc(s, s.owner(), "recordSale", body("saleId", id, "items", items, "payment", Map.of("method", "card", "cashCents", 5000, "amountReceivedCents", 5000)));
    assertThat(res.<Integer>get("totalCents")).isEqualTo(8000);
    var session = openSession(s);
    assertThat(Domain.cents(session.get("cashSalesCents"))).isEqualTo(5000);
    assertThat(Domain.cents(session.get("cardSalesCents"))).isEqualTo(3000);
    rpc(s, s.owner(), "requestRefund", body("saleId", id, "reason", "Customer changed mind"));
    assertThat(Domain.cents(openSession(s).get("cashRefundsCents"))).isEqualTo(5000);
  }

  @Test
  void keepsCustomersAndAStampCardTheServerDecidesTheReward() {
    TestShop s = newShop();
    Person cashier = addStaff(s, "employee", "Sipho");
    rpc(s, s.owner(), "openShift", body("openingFloatCents", 0, "checklist", List.of()));
    tx.executeWithoutResult(t -> store.merge(s.businessId(), "businessSettings", "main",
        Map.of("loyalty", Map.of("enabled", true, "stampsNeeded", 2, "minSpendCents", 3000, "rewardValueCents", 5000))));
    String kota = product(s, "Loyal Kota", 4000);
    var items = List.of(Map.of("productId", kota, "quantity", 1));
    java.util.function.BiFunction<String, Map<String, Object>, Res> sell = (n, customer) ->
        rpc(s, s.owner(), "recordSale", body("saleId", saleId("loyal" + n), "items", items, "payment", Map.of("method", "card"), "customer", customer));

    assertThat(sell.apply("x", Map.of("phone", "12345")).<String>get("message")).contains("cellphone number");
    sell.apply("1", Map.of("phone", "082 555 0001", "name", "Lerato"));
    assertThat(sell.apply("2", Map.of("phone", "0825550001", "redeemReward", true)).<String>get("message")).contains("isn't full yet");
    sell.apply("3", Map.of("phone", "+27 82 555 0001"));
    assertThat(store.get(s.businessId(), "customers", "27825550001").orElseThrow())
        .containsEntry("name", "Lerato").containsEntry("visits", 2).containsEntry("stamps", 2).containsEntry("spentCents", 8000);

    // a full card: up to R50 off a R40 kota = free, and no stamp for a free sale
    Res free = sell.apply("4", Map.of("phone", "0825550001", "redeemReward", true));
    assertThat(free.<Integer>get("totalCents")).isZero();
    assertThat(store.get(s.businessId(), "customers", "27825550001").orElseThrow())
        .containsEntry("visits", 3).containsEntry("stamps", 0).containsEntry("rewardsRedeemed", 1);
    // a cashier looks up one number but can't list everyone
    assertThat(get("/api/shops/" + s.businessId() + "/data/customers/27825550001", cashier.token()).status()).isEqualTo(200);
    assertThat(post("/api/shops/" + s.businessId() + "/query", cashier.token(), body("collection", "customers")).status()).isEqualTo(403);
  }

  private int yocoWebhook(String b, String body, Map<String, String> headers) throws Exception {
    HttpRequest.Builder req = HttpRequest.newBuilder(URI.create("http://localhost:" + localPort + "/api/webhooks/yoco?b=" + b))
        .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(body));
    headers.forEach(req::header);
    return HttpClient.newHttpClient().send(req.build(), HttpResponse.BodyHandlers.discarding()).statusCode();
  }

  private static Map<String, String> signed(String body) throws Exception {
    String ts = String.valueOf(System.currentTimeMillis() / 1000);
    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec("kotahouse-emulator-yoco".getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
    String sig = Base64.getEncoder().encodeToString(mac.doFinal(("msg_1." + ts + "." + body).getBytes(StandardCharsets.UTF_8)));
    return Map.of("webhook-id", "msg_1", "webhook-timestamp", ts, "webhook-signature", "v1," + sig);
  }

  @Test
  void takesCardPaymentsOnTheCustomersPhoneOnlyOnceYocoConfirmsThem() throws Exception {
    TestShop s = newShop();
    String b = s.businessId();
    rpc(s, s.owner(), "openShift", body("openingFloatCents", 0, "checklist", List.of()));
    assertThat(rpc(s, s.owner(), "connectYoco", body("secretKey", "pk_test_123")).<String>get("message")).contains("sk_live_ or sk_test_");
    assertThat(rpc(s, s.owner(), "connectYoco", body("secretKey", "sk_test_abcdefghijkl")).<String>get("mode")).isEqualTo("test");
    // the key is out of reach of every app user, even the owner
    assertThat(get("/api/shops/" + b + "/data/private/yoco", s.owner().token()).status()).isEqualTo(403);

    String kota = product(s, "Card Kota", 4500);
    String id = saleId("yoco");
    Map<String, Object> sale = body("saleId", id, "items", List.of(Map.of("productId", kota, "quantity", 1)));
    Res checkout = rpc(s, s.owner(), "createYocoCheckout", body("saleId", id, "amountCents", 4500));
    String checkoutId = checkout.get("checkoutId");
    assertThat(checkout.<String>get("redirectUrl")).contains(checkoutId);
    assertThat(rpc(s, s.owner(), "createYocoCheckout", body("saleId", id, "amountCents", 4500)).<String>get("checkoutId")).isEqualTo(checkoutId);
    Map<String, Object> pay = new HashMap<>(sale);
    pay.put("payment", Map.of("method", "card", "yocoCheckoutId", checkoutId));
    assertThat(rpc(s, s.owner(), "recordSale", pay).<String>get("message")).contains("not finished paying");

    String event = "{\"id\":\"evt_1\",\"type\":\"payment.succeeded\",\"payload\":{\"id\":\"p_123\",\"amount\":4500,\"status\":\"succeeded\",\"mode\":\"test\",\"type\":\"payment\",\"metadata\":{\"checkoutId\":\"" + checkoutId + "\"}}}";
    assertThat(yocoWebhook(b, event, Map.of("webhook-id", "msg_1", "webhook-timestamp", "1", "webhook-signature", "v1,forged"))).isEqualTo(403);
    assertThat(yocoWebhook(b, event, signed(event))).isEqualTo(200);
    assertThat(store.get(b, "yocoCheckouts", checkoutId).orElseThrow().get("status")).isEqualTo("paid");

    assertThat(rpc(s, s.owner(), "recordSale", pay).<Integer>get("totalCents")).isEqualTo(4500);
    assertThat(Domain.map(store.get(b, "sales", id).orElseThrow().get("payment")))
        .containsEntry("verified", true).containsEntry("reference", "p_123").containsEntry("yocoCheckoutId", checkoutId);
    // one payment can't pay for a second sale
    Map<String, Object> again = new HashMap<>(pay);
    again.put("saleId", saleId("yoco2"));
    assertThat(rpc(s, s.owner(), "recordSale", again).<String>get("message")).containsAnyOf("another sale", "already used");
  }

  @Test
  void takesOrdersOnWhatsAppAndTellsTheCustomerWhenItsReady() throws Exception {
    TestShop s = newShop();
    String b = s.businessId();
    rpc(s, s.owner(), "openShift", body("openingFloatCents", 0, "checklist", List.of()));
    String phoneId = String.valueOf(1_000_000_000L + (long) (Math.random() * 8_000_000_000L));
    assertThat(rpc(s, s.owner(), "linkWhatsapp", body("ordering", true, "phoneNumberId", phoneId, "displayNumber", "+27 82 000 0000")).status()).isEqualTo(200);
    tx.executeWithoutResult(t -> store.merge(b, "businessSettings", "main", Map.of("openingHour", 0, "closingHour", 24, "tradingDays", List.of(0, 1, 2, 3, 4, 5, 6))));
    product(s, "Russian Kota", 5000);

    String customer = "27820000001";
    int[] n = {0};
    java.util.function.BiFunction<String, String, Integer> send = (text, msgId) -> {
      String body = "{\"entry\":[{\"changes\":[{\"value\":{\"metadata\":{\"phone_number_id\":\"" + phoneId + "\"},"
          + "\"contacts\":[{\"wa_id\":\"" + customer + "\",\"profile\":{\"name\":\"Lerato\"}}],"
          + "\"messages\":[{\"id\":\"" + msgId + "\",\"from\":\"" + customer + "\",\"type\":\"text\",\"text\":{\"body\":\"" + text + "\"}}]}}]}]}";
      try {
        return HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create("http://localhost:" + localPort + "/api/webhooks/whatsapp"))
            .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.discarding()).statusCode();
      } catch (Exception e) {
        throw new RuntimeException(e);
      }
    };
    java.util.function.Supplier<List<String>> outgoing = () -> store.list(b, Query.of("whatsappMessages").where("direction", "==", "out").build())
        .stream().map(m -> String.valueOf(m.get("text"))).toList();

    assertThat(send.apply("hi", "wamid." + (++n[0]))).isEqualTo(200);
    assertThat(outgoing.get()).anyMatch(m -> m.contains("1. Russian Kota"));
    send.apply("1x2", "wamid." + (++n[0]));
    String noteId = "wamid." + (++n[0]);
    send.apply("note: extra chips", noteId);
    send.apply("yes", "wamid." + (++n[0]));
    var orders = store.list(b, Query.of("orders").where("source", "==", "whatsapp").build());
    assertThat(orders).hasSize(1);
    var order = orders.get(0);
    assertThat(order).containsEntry("ticketNo", 1).containsEntry("totalCents", 10000).containsEntry("paid", false)
        .containsEntry("note", "extra chips").containsEntry("customerName", "Lerato");
    assertThat(outgoing.get()).anyMatch(m -> m.contains("Order *#W1* received"));

    // WhatsApp re-delivering a message must not run it twice
    int before = outgoing.get().size();
    send.apply("note: extra chips", noteId);
    assertThat(outgoing.get()).hasSize(before);

    // staff mark it ready → the customer is told to come and collect
    rpc(s, s.owner(), "setOrderStatus", body("orderId", order.get("id"), "status", "ready"));
    assertThat(outgoing.get()).anyMatch(m -> m.contains("#W1 is *ready to collect*"));
  }

  @Test
  void theFifteenMinuteCheckFlagsAShiftLeftOpenFromAnEarlierDay() {
    TestShop s = newShop();
    String b = s.businessId();
    rpc(s, s.owner(), "openShift", body("openingFloatCents", 2000, "checklist", List.of()));
    var shift = store.list(b, Query.of("shifts").where("status", "==", "open").build()).get(0);
    tx.executeWithoutResult(t -> store.update(b, "shifts", (String) shift.get("id"), Map.of("dayKey", "2020-01-01")));
    monitor.run();
    monitor.run(); // twice: still one alert
    var alerts = store.list(b, Query.of("notifications").where("type", "==", "missingClose").build());
    assertThat(alerts).singleElement().satisfies(a -> assertThat(a.toString()).contains("Cash that should be in the till"));
  }
}
