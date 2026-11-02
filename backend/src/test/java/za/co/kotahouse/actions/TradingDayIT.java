package za.co.kotahouse.actions;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.junit.jupiter.api.TestMethodOrder;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.transaction.support.TransactionTemplate;
import za.co.kotahouse.ApiTestBase;
import za.co.kotahouse.domain.Domain;
import za.co.kotahouse.store.Query;
import za.co.kotahouse.store.Store;
import za.co.kotahouse.store.Ts;

/**
 * A full trading day against the Java backend: the scenario and amounts of
 * functions/test/integration/day-flow.spec.ts, so both backends must agree.
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class TradingDayIT extends ApiTestBase {
  @Autowired
  Store store;

  @Autowired
  TransactionTemplate tx;

  final String run = UUID.randomUUID().toString().replace("-", "").substring(0, 8);
  TestShop shop;
  Person cashier;
  String b;
  String shiftId;
  String firstSaleId;
  String basic;
  String russian;
  String bread;
  String chips;
  String russianSausage;

  @BeforeAll
  void setUp() {
    client();
    shop = newShop();
    b = shop.businessId();
    // the menu (catalogue actions come with the next module)
    tx.executeWithoutResult(t -> {
      bread = ingredient("Bread", "each", 450, 20);
      chips = ingredient("Chips", "kg", 2000, 5);
      russianSausage = ingredient("Russian", "each", 900, 3);
      basic = product("Basic Kota", 3500, List.of(List.of(bread, 1), List.of(chips, 0.15)));
      russian = product("Russian Kota", 5500, List.of(List.of(bread, 1), List.of(chips, 0.15), List.of(russianSausage, 1)));
    });
    cashier = addStaff(shop, "employee", "Sipho");
  }

  private String ingredient(String name, String unit, long cost, double qty) {
    String id = store.newId();
    store.set(b, "ingredients", id, Map.of("name", name, "unit", unit, "unitCostCents", cost, "openingQty", qty, "currentQty", qty, "reorderLevel", 2, "active", true));
    return id;
  }

  private String product(String name, long price, List<List<Object>> recipe) {
    String id = store.newId();
    store.set(b, "products", id, Map.of("name", name, "category", "kota", "priceCents", price, "active", true, "sortOrder", 1));
    store.set(b, "recipes", id, Map.of("productId", id, "lines", recipe.stream().map(l -> Map.of("ingredientId", l.get(0), "quantity", l.get(1))).toList()));
    return id;
  }

  private Res rpc(Person p, String name, Map<String, Object> data) {
    Map<String, Object> withShop = new java.util.HashMap<>(data);
    withShop.put("businessId", b);
    return post("/api/rpc/" + name, p.token(), withShop);
  }

  private Map<String, Object> session() {
    return store.list(b, Query.of("cashSessions").where("status", "==", "open").build()).get(0);
  }

  private double stockOf(String id) {
    return Domain.num(store.get(b, "ingredients", id).orElseThrow().get("currentQty"));
  }

  private static List<Map<String, Object>> items(Object... idQty) {
    List<Map<String, Object>> out = new java.util.ArrayList<>();
    for (int i = 0; i < idQty.length; i += 2) out.add(Map.of("productId", idQty[i], "quantity", idQty[i + 1]));
    return out;
  }

  @Test
  @Order(1)
  void opensAShiftWithAFloatAndOnlyOneAtATime() {
    Res open = rpc(cashier, "openShift", body("openingFloatCents", 50000, "checklist", List.of()));
    assertThat(open.status()).isEqualTo(200);
    shiftId = open.get("shiftId");
    assertThat(rpc(shop.owner(), "openShift", body("openingFloatCents", 0, "checklist", List.of())).<String>get("message")).contains("still open");
  }

  @Test
  @Order(2)
  void pricesOnTheServerGivesChangeAndDeductsRecipeStock() {
    firstSaleId = "sale1" + run + "abcdefghij";
    Res res = rpc(cashier, "recordSale", body("saleId", firstSaleId, "items", items(basic, 2, russian, 1), "payment", Map.of("method", "cash", "amountReceivedCents", 20000)));
    assertThat(res.<Integer>get("totalCents")).isEqualTo(12500);
    assertThat(res.<Integer>get("changeCents")).isEqualTo(7500);
    assertThat(res.<Boolean>get("duplicate")).isFalse();
    assertThat(stockOf(bread)).isEqualTo(17);
    assertThat(stockOf(chips)).isCloseTo(4.55, within(0.001));
    assertThat(stockOf(russianSausage)).isEqualTo(2);
  }

  @Test
  @Order(3)
  void neverRecordsARetriedSaleTwice() {
    Res again = rpc(cashier, "recordSale", body("saleId", firstSaleId, "items", items(basic, 2, russian, 1), "payment", Map.of("method", "cash", "amountReceivedCents", 20000)));
    assertThat(again.<Boolean>get("duplicate")).isTrue();
    assertThat(Domain.cents(session().get("cashSalesCents"))).isEqualTo(12500);
    assertThat(stockOf(bread)).isEqualTo(17);
  }

  @Test
  @Order(4)
  void rejectsShortCashAndCashierDiscountsAboveTheLimit() {
    assertThat(rpc(cashier, "recordSale", body("saleId", "short" + run + "abcdefghij", "items", items(basic, 1), "payment", Map.of("method", "cash", "amountReceivedCents", 1000)))
        .<String>get("message")).contains("at least the order total");
    assertThat(rpc(cashier, "recordSale", body("saleId", "disc" + run + "abcdefghijk", "items", items(basic, 1), "discountCents", 500, "discountReason", "friend", "payment", Map.of("method", "card")))
        .<String>get("message")).contains("need the owner");
  }

  @Test
  @Order(5)
  void recordsCardAndEftSalesSeparatelyFromCash() {
    rpc(cashier, "recordSale", body("saleId", "card" + run + "abcdefghijk", "items", items(basic, 1), "payment", Map.of("method", "card")));
    rpc(cashier, "recordSale", body("saleId", "eft" + run + "abcdefghijkl", "items", items(basic, 1), "payment", Map.of("method", "eft", "reference", "INV1")));
    var s = session();
    assertThat(Domain.cents(s.get("cardSalesCents"))).isEqualTo(3500);
    assertThat(Domain.cents(s.get("eftSalesCents"))).isEqualTo(3500);
    assertThat(Domain.cents(s.get("cashSalesCents"))).isEqualTo(12500);
  }

  @Test
  @Order(6)
  void cashierRefundsNeedOwnerApprovalAndCashRefundsLeaveTheTill() {
    String saleId = "refund" + run + "abcdefghi";
    rpc(cashier, "recordSale", body("saleId", saleId, "items", items(basic, 1), "payment", Map.of("method", "cash", "amountReceivedCents", 3500)));
    String approvalId = rpc(cashier, "requestRefund", body("saleId", saleId, "reason", "Wrong order")).get("approvalId");
    assertThat(store.get(b, "sales", saleId).orElseThrow().get("status")).isEqualTo("refundPending");
    assertThat(Domain.cents(session().get("cashRefundsCents"))).isZero();

    assertThat(rpc(cashier, "decideApproval", body("approvalId", approvalId, "approve", true)).<String>get("message")).contains("not allowed");
    assertThat(rpc(shop.owner(), "decideApproval", body("approvalId", approvalId, "approve", true)).status()).isEqualTo(200);
    assertThat(store.get(b, "sales", saleId).orElseThrow().get("status")).isEqualTo("refunded");
    assertThat(Domain.cents(session().get("cashRefundsCents"))).isEqualTo(3500);
  }

  @Test
  @Order(7)
  void onlyApprovedTillExpensesReduceExpectedCash() {
    assertThat(rpc(cashier, "submitExpense", body("amountCents", 4000, "category", "Gas", "description", "Gas refill", "date", "2026-01-01", "paidFromTill", true)).status()).isEqualTo(200);
    var pending = store.list(b, Query.of("approvals").where("status", "==", "pending").where("type", "==", "expense").build());
    assertThat(Domain.cents(session().get("pendingCashExpensesCents"))).isEqualTo(4000);
    assertThat(Domain.cents(session().get("approvedCashExpensesCents"))).isZero();
    rpc(shop.owner(), "decideApproval", body("approvalId", pending.get(0).get("id"), "approve", true));
    var s = session();
    assertThat(Domain.cents(s.get("pendingCashExpensesCents"))).isZero();
    assertThat(Domain.cents(s.get("approvedCashExpensesCents"))).isEqualTo(4000);
  }

  @Test
  @Order(8)
  void letsACashierAddStockWithoutACostLeavingTheCostUnchanged() {
    double before = stockOf(chips);
    long costBefore = Domain.cents(store.get(b, "ingredients", chips).orElseThrow().get("unitCostCents"));
    assertThat(rpc(cashier, "recordPurchase", body("lines", List.of(Map.of("ingredientId", chips, "quantity", 2)), "paidFromTillCents", 0)).status()).isEqualTo(200);
    assertThat(stockOf(chips)).isCloseTo(before + 2, within(0.001));
    assertThat(Domain.cents(store.get(b, "ingredients", chips).orElseThrow().get("unitCostCents"))).isEqualTo(costBefore);
    // give it back so the rest of the day's numbers stay as planned
    assertThat(rpc(shop.owner(), "recordStockMovement", body("ingredientId", chips, "type", "adjustment", "quantity", -2, "reason", "Test undo")).status()).isEqualTo(200);
  }

  @Test
  @Order(9)
  void recordsDeliveriesPaidFromTheTillWastageAndPayouts() {
    rpc(cashier, "recordPurchase", body("lines", List.of(Map.of("ingredientId", bread, "quantity", 10, "unitCostCents", 500)), "paidFromTillCents", 5000));
    assertThat(stockOf(bread)).isEqualTo(17 - 1 - 1 - 1 + 10);
    rpc(cashier, "recordStockMovement", body("ingredientId", chips, "type", "wastage", "quantity", 0.5, "reason", "Burnt batch"));
    rpc(cashier, "recordPayout", body("amountCents", 10000, "reason", "Cash drop to owner"));
    assertThat(Domain.cents(session().get("cashPayoutsCents"))).isEqualTo(15000);
    // cashiers can't move stock with a direct correction – it becomes a request
    assertThat(rpc(cashier, "recordStockMovement", body("ingredientId", bread, "type", "adjustment", "quantity", 5, "reason", "Found extra")).<String>get("approvalId")).isNotBlank();
  }

  @Test
  @Order(10)
  void recordsQueuedOfflineSalesAtTheTimeTheyHappenedAndFlagsPriceChanges() {
    long soldAt = System.currentTimeMillis() - 30 * 60_000;
    String saleId = "offline" + run + "abcdefgh";
    Res res = rpc(cashier, "recordSale", body("saleId", saleId, "items", items(basic, 1), "payment", Map.of("method", "card"), "soldAtMillis", soldAt, "expectedTotalCents", 3000));
    assertThat(res.<Integer>get("totalCents")).isEqualTo(3500);
    var sale = store.get(b, "sales", saleId).orElseThrow();
    assertThat(sale.get("offline")).isEqualTo(true);
    assertThat(Ts.millis(sale.get("soldAt"))).isEqualTo(soldAt);
    assertThat(store.list(b, Query.of("notifications").where("type", "==", "priceMismatch").build())).hasSize(1);
    assertThat(rpc(cashier, "recordSale", body("saleId", "stale" + run + "abcdefghij", "items", items(basic, 1), "payment", Map.of("method", "card"),
        "soldAtMillis", System.currentTimeMillis() - 48 * 3_600_000L)).<String>get("message")).contains("older than 24 hours");
  }

  @Test
  @Order(11)
  void willNotCloseUntilHighRiskItemsAreCounted() {
    tx.executeWithoutResult(t -> store.update(b, "ingredients", russianSausage, Map.of("countDaily", true)));
    assertThat(rpc(cashier, "closeShift", body("shiftId", shiftId, "countedCashCents", 43500, "checklist", List.of(), "stockCounts", List.of())).<String>get("message"))
        .contains("Count these items before closing: Russian");
  }

  @Test
  @Order(12)
  void closesWithABlindCountAndDifferencesNeedAnExplanation() {
    // expected = 50000 float + 16000 cash sales − 3500 refund − 4000 expense − 15000 paid out = 43500
    List<Map<String, Object>> counts = List.of(Map.of("ingredientId", russianSausage, "countedQty", 1));
    assertThat(rpc(cashier, "closeShift", body("shiftId", shiftId, "countedCashCents", 43000, "checklist", List.of(), "stockCounts", counts)).<String>get("message"))
        .contains("Explain the cash difference");
    Res res = rpc(cashier, "closeShift", body("shiftId", shiftId, "countedCashCents", 43000, "cardTerminalTotalCents", 7000,
        "explanation", "Gave R5 too much change", "checklist", List.of(), "stockCounts", counts));
    assertThat(res.<Integer>get("expectedCashCents")).isEqualTo(43500);
    assertThat(res.<Integer>get("differenceCents")).isEqualTo(-500);
    assertThat(res.<Integer>get("cardDifferenceCents")).isZero();
    assertThat(res.<List<Map<String, Object>>>get("stockVariances")).singleElement().satisfies(v -> assertThat(Domain.num(v.get("varianceQty"))).isEqualTo(-1));
    var closed = store.get(b, "cashSessions", shiftId).orElseThrow();
    assertThat(closed.get("status")).isEqualTo("closed");
    assertThat(Domain.cents(closed.get("differenceCents"))).isEqualTo(-500);
  }

  @Test
  @Order(13)
  void keepsDailyStatsThatSeparateRevenueFromProfit() {
    var stats = store.list(b, Query.of("dailyStats").build());
    long sales = stats.stream().mapToLong(s -> Domain.cents(s.get("grossSalesCents"))).sum();
    assertThat(sales).isEqualTo(12500 + 3500 * 4);
    assertThat(stats.stream().mapToLong(s -> Domain.cents(s.get("refundsCents"))).sum()).isEqualTo(3500);
    assertThat(stats.stream().mapToLong(s -> Domain.cents(s.get("orders"))).sum()).isEqualTo(5);
    assertThat(stats.stream().mapToLong(s -> Domain.cents(s.get("cogsCents"))).sum()).isPositive();
    assertThat(stats.stream().mapToLong(s -> Domain.cents(s.get("wastageCostCents"))).sum()).isEqualTo(1000);
    assertThat(stats.stream().mapToLong(s -> Domain.cents(s.get("operatingExpensesCents"))).sum()).isEqualTo(4000);
  }

  @Test
  @Order(14)
  void writesAnAuditTrailAndOwnerNotifications() {
    var actions = store.list(b, Query.of("auditLogs").build()).stream().map(a -> a.get("action")).toList();
    assertThat(actions).contains("business.created", "employee.created", "shift.opened", "sale.recorded", "refund.requested", "approval.approved",
        "expense.submitted", "stock.purchase", "stock.wastage", "cash.payout", "shift.closed");
    var types = store.list(b, Query.of("notifications").build()).stream().map(n -> n.get("type")).toList();
    assertThat(types).contains("refundRequest", "pendingExpense", "shiftClosed", "cashPayout", "tillPurchase");
  }

  @Test
  @Order(15)
  void cashiersCantTouchAnotherShopOrDoOwnerThings() {
    TestShop other = newShop();
    assertThat(post("/api/rpc/recordPayout", cashier.token(), body("businessId", other.businessId(), "amountCents", 100, "reason", "test")).<String>get("message"))
        .contains("not linked to this shop");
    assertThat(rpc(cashier, "verifyPayment", body("saleId", firstSaleId, "verified", true)).<String>get("message")).contains("not allowed");
  }
}
