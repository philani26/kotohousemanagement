package za.co.kotahouse.domain;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static za.co.kotahouse.domain.Domain.CartItem;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import za.co.kotahouse.common.ApiException;

/** The cases of functions/src/shared/domain.spec.ts, against the Java port. */
class DomainTest {
  private static Map<String, Object> product(String id, long price, boolean active) {
    return Map.of("id", id, "name", id, "category", "kota", "priceCents", price, "active", active);
  }

  private static final Map<String, Map<String, Object>> PRODUCTS = Map.of(
      "basic", product("basic", 3500, true), "russian", product("russian", 5500, true), "old", product("old", 1000, false));

  private static Map<String, Object> ingredient(String id, long unitCost, double qty) {
    return Map.of("id", id, "name", id, "unit", "each", "currentQty", qty, "unitCostCents", unitCost, "reorderLevel", 10, "active", true);
  }

  private static final Map<String, Map<String, Object>> INGREDIENTS = Map.of(
      "bread", ingredient("bread", 450, 100), "chips", ingredient("chips", 2000, 100), "russian", ingredient("russian", 900, 100));

  private static final Map<String, Map<String, Object>> RECIPES = Map.of(
      "basic", Map.of("productId", "basic", "lines", List.of(Map.of("ingredientId", "bread", "quantity", 0.25), Map.of("ingredientId", "chips", "quantity", 0.15))),
      "russian", Map.of("productId", "russian", "lines", List.of(Map.of("ingredientId", "bread", "quantity", 0.25), Map.of("ingredientId", "chips", "quantity", 0.15),
          Map.of("ingredientId", "russian", "quantity", 1))));

  @Test
  void pricesFromTheProductListMergesLinesAndAppliesDiscounts() {
    var sale = Domain.priceCart(List.of(new CartItem("basic", 2), new CartItem("russian", 1)), PRODUCTS, 0);
    assertThat(sale.subtotalCents()).isEqualTo(12500);
    assertThat(sale.totalCents()).isEqualTo(12500);
    assertThat(Domain.priceCart(List.of(new CartItem("basic", 1), new CartItem("basic", 2)), PRODUCTS, 0).lines()).singleElement()
        .satisfies(l -> assertThat(l.get("quantity")).isEqualTo(3));
    assertThat(Domain.priceCart(List.of(new CartItem("basic", 1)), PRODUCTS, 500).totalCents()).isEqualTo(3000);
    assertThatThrownBy(() -> Domain.priceCart(List.of(new CartItem("basic", 1)), PRODUCTS, 4000)).isInstanceOf(ApiException.class);
    assertThatThrownBy(() -> Domain.priceCart(List.of(new CartItem("basic", 1)), PRODUCTS, -1)).isInstanceOf(ApiException.class);
    assertThatThrownBy(() -> Domain.priceCart(List.of(), PRODUCTS, 0)).isInstanceOf(ApiException.class);
    assertThatThrownBy(() -> Domain.priceCart(List.of(new CartItem("basic", 0)), PRODUCTS, 0)).isInstanceOf(ApiException.class);
    assertThatThrownBy(() -> Domain.priceCart(List.of(new CartItem("old", 1)), PRODUCTS, 0)).isInstanceOf(ApiException.class);
    assertThatThrownBy(() -> Domain.priceCart(List.of(new CartItem("nope", 1)), PRODUCTS, 0)).isInstanceOf(ApiException.class);
  }

  @Test
  void settlesCashCardAndSplitPayments() {
    assertThat(Domain.settlePayment("cash", 3500, 5000L, null)).isEqualTo(new Domain.Settled("cash", null, 5000L, 1500L));
    assertThatThrownBy(() -> Domain.settlePayment("cash", 3500, 3000L, null)).isInstanceOf(ApiException.class);
    assertThatThrownBy(() -> Domain.settlePayment("cash", 3500, null, null)).isInstanceOf(ApiException.class);
    assertThat(Domain.settlePayment("card", 3500, 9999L, null)).isEqualTo(new Domain.Settled("card", null, null, null));
    assertThat(Domain.settlePayment("card", 8000, 5000L, 5000L)).isEqualTo(new Domain.Settled("card", 5000L, 5000L, 0L));
    assertThat(Domain.settlePayment("eft", 8000, 10000L, 3000L)).isEqualTo(new Domain.Settled("eft", 3000L, 10000L, 7000L));
    assertThatThrownBy(() -> Domain.settlePayment("card", 8000, 2000L, 3000L)).hasMessageContaining("cash part");
    assertThatThrownBy(() -> Domain.settlePayment("card", 8000, null, 3000L)).isInstanceOf(ApiException.class);
    assertThatThrownBy(() -> Domain.settlePayment("card", 8000, 5000L, -1L)).isInstanceOf(ApiException.class);
    assertThat(Domain.settlePayment("card", 4000, 5000L, 5000L)).isEqualTo(new Domain.Settled("cash", null, 5000L, 1000L));
  }

  @Test
  void splitsASaleByMethod() {
    assertThat(Domain.paymentParts(Map.of("method", "cash"), 3500)).containsExactly(new Domain.Part("cash", 3500));
    assertThat(Domain.paymentParts(Map.of("method", "card"), 3500)).containsExactly(new Domain.Part("card", 3500));
    assertThat(Domain.paymentParts(Map.of("method", "card", "cashCents", 1000), 3500)).containsExactly(new Domain.Part("cash", 1000), new Domain.Part("card", 2500));
    assertThat(Domain.cashPartCents(Map.of("method", "eft", "cashCents", 1000), 3500)).isEqualTo(1000);
    assertThat(Domain.cashPartCents(Map.of("method", "eft"), 3500)).isZero();
    assertThat(Domain.paymentLabel(Map.of("method", "card", "cashCents", 1000))).isEqualTo("cash + card");
  }

  @Test
  void costsRecipesWithoutFloatingPointDrift() {
    var r = Domain.ingredientUsage(List.of(Map.of("productId", "basic", "quantity", 2), Map.of("productId", "russian", "quantity", 1)), RECIPES, INGREDIENTS);
    assertThat(r.usage()).contains(new Domain.Usage("bread", 0.75, Math.round(0.75 * 450)), new Domain.Usage("chips", 0.45, Math.round(0.45 * 2000)));
    assertThat(r.costCents()).isEqualTo(Math.round(0.75 * 450) + Math.round(0.45 * 2000) + 900);
    assertThat(Domain.ingredientUsage(List.of(Map.of("productId", "other", "quantity", 3)), RECIPES, INGREDIENTS).usage()).isEmpty();
    assertThat(Domain.ingredientUsage(List.of(Map.of("productId", "basic", "quantity", 3)), RECIPES, INGREDIENTS).usage())
        .filteredOn(u -> u.ingredientId().equals("chips")).singleElement().satisfies(u -> assertThat(u.quantity()).isEqualTo(0.45));
  }

  @Test
  void reconcilesCash() {
    Map<String, Object> s = Map.of("openingFloatCents", 50000, "cashSalesCents", 120000, "cashRefundsCents", 5000, "approvedCashExpensesCents", 10000, "cashPayoutsCents", 20000);
    assertThat(Domain.expectedCash(s)).isEqualTo(135000);
    assertThat(Domain.reconcileCash(s, 135000, 2000)).isEqualTo(new Domain.CashClose(135000, 0, false, false));
    assertThat(Domain.reconcileCash(s, 134000, 2000)).isEqualTo(new Domain.CashClose(135000, -1000, true, false));
    assertThat(Domain.reconcileCash(s, 132000, 2000).isAlert()).isTrue();
    assertThat(Domain.reconcileCash(s, 138000, 2000).isAlert()).isTrue();
  }

  @Test
  void countsStockAndNeverGoesNegative() {
    var line = Domain.stockCountLine(ingredient("russian", 900, 20), 17);
    assertThat(line).containsEntry("varianceQty", -3.0).containsEntry("varianceCents", -2700L);
    assertThatThrownBy(() -> Domain.stockCountLine(ingredient("russian", 900, 20), -1)).isInstanceOf(ApiException.class);
    assertThat(Domain.isLowStock(ingredient("x", 1, 10))).isTrue();
    assertThat(Domain.isLowStock(ingredient("x", 1, 11))).isFalse();

    assertThat(Domain.clampStockChange(10, -3)).isEqualTo(new Domain.Clamped(-3, 7, 0, false));
    assertThat(Domain.clampStockChange(1, -2)).isEqualTo(new Domain.Clamped(-1, 0, 1, true));
    assertThat(Domain.clampStockChange(2, -2).ranOut()).isTrue();
    var old = Domain.clampStockChange(-5, -1);
    assertThat(old.newQty()).isZero();
    assertThat(Double.compare(old.newQty(), 0.0)).isZero(); // not -0
    assertThat(Domain.reorderQty(3, 10)).isEqualTo(17);
    assertThat(Domain.reorderQty(30, 10)).isZero();
  }

  @Test
  void offlineSalesKeepTheirTime() {
    long now = 1_800_000_000_000L;
    assertThat(Domain.resolveSoldAt(null, now)).isEqualTo(new Domain.SoldAt(now, false));
    assertThat(Domain.resolveSoldAt(now - 3_600_000, now)).isEqualTo(new Domain.SoldAt(now - 3_600_000, true));
    assertThat(Domain.resolveSoldAt(now + 60_000, now).offline()).isFalse(); // small clock skew
    assertThatThrownBy(() -> Domain.resolveSoldAt(now + 10 * 60_000, now)).hasMessageContaining("future");
    assertThatThrownBy(() -> Domain.resolveSoldAt(now - 25 * 3_600_000L, now)).hasMessageContaining("24 hours");
  }

  @Test
  void textMoneyAndPhones() {
    assertThat(Domain.formatZar(123456)).isEqualTo("R 1 234,56");
    assertThat(Domain.formatZar(-500)).isEqualTo("-R 5,00");
    assertThat(Domain.centsToRandString(4550)).isEqualTo("45.50");
    assertThat(Domain.waPhone("082 123 4567")).isEqualTo("27821234567");
    assertThat(Domain.waPhone("+27 82 123 4567")).isEqualTo("27821234567");
    assertThat(Domain.waPhone("123")).isNull();
    assertThat(Domain.inOrderQueue(Map.of("category", "extras"))).isFalse();
    assertThat(Domain.inOrderQueue(Map.of("category", "extras", "orderQueue", true))).isTrue();
    assertThat(Domain.inOrderQueue(Map.of("category", "kota"))).isTrue();
  }
}
