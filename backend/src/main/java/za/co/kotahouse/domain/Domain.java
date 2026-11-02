package za.co.kotahouse.domain;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import za.co.kotahouse.common.ApiException;

/**
 * Pure business rules, ported one-to-one from functions/src/shared/domain.ts
 * (and its tests to DomainTest). Records are plain maps, as stored.
 * Money is always whole cents (long).
 */
public final class Domain {
  private Domain() {}

  public static final int MAX_LINE_QTY = 50;
  public static final int MAX_LINES = 30;
  public static final long MAX_OFFLINE_MS = 24 * 60 * 60 * 1000L;

  /** A rule was broken: shown to the person as an invalid-argument error. */
  public static ApiException error(String message) {
    return ApiException.invalid(message);
  }

  public static double roundQty(double q) {
    double r = Math.round(q * 1000) / 1000.0;
    return r == 0 ? 0 : r; // never -0
  }

  // ------------------------------------------------------------------ reading records

  public static long cents(Object v) {
    return v instanceof Number n ? Math.round(n.doubleValue()) : 0;
  }

  public static double num(Object v) {
    return v instanceof Number n ? n.doubleValue() : 0;
  }

  public static String str(Object v) {
    return v == null ? null : v.toString();
  }

  @SuppressWarnings("unchecked")
  public static Map<String, Object> map(Object v) {
    return v instanceof Map<?, ?> m ? (Map<String, Object>) m : Map.of();
  }

  @SuppressWarnings("unchecked")
  public static List<Map<String, Object>> list(Object v) {
    return v instanceof List<?> l ? (List<Map<String, Object>>) l : List.of();
  }

  // ------------------------------------------------------------------ pricing

  public record CartItem(String productId, int quantity) {}

  public record Priced(List<Map<String, Object>> lines, long subtotalCents, long discountCents, long totalCents) {
    public Priced withReward(long rewardCents) {
      return new Priced(lines, subtotalCents, discountCents + rewardCents, totalCents - rewardCents);
    }
  }

  /** Prices a cart from the authoritative product list. Rejects unknown/inactive items. */
  public static Priced priceCart(List<CartItem> items, Map<String, Map<String, Object>> products, long discountCents) {
    if (items == null || items.isEmpty()) throw error("The order is empty");
    if (items.size() > MAX_LINES) throw error("Too many lines in one order");
    Map<String, Integer> merged = new LinkedHashMap<>();
    for (CartItem item : items) {
      if (item.quantity() < 1 || item.quantity() > MAX_LINE_QTY) throw error("Invalid quantity for " + item.productId());
      merged.merge(item.productId(), item.quantity(), Integer::sum);
    }
    List<Map<String, Object>> lines = new ArrayList<>();
    long subtotal = 0;
    for (var e : merged.entrySet()) {
      Map<String, Object> p = products.get(e.getKey());
      if (p == null || !Boolean.TRUE.equals(p.get("active"))) throw error("Product is not available: " + e.getKey());
      long price = cents(p.get("priceCents"));
      Map<String, Object> line = new LinkedHashMap<>();
      line.put("productId", e.getKey());
      line.put("name", p.get("name"));
      line.put("quantity", e.getValue());
      line.put("unitPriceCents", price);
      line.put("lineTotalCents", price * e.getValue());
      lines.add(line);
      subtotal += price * e.getValue();
    }
    if (discountCents < 0 || discountCents > subtotal) throw error("Discount must be between R0 and the order subtotal");
    return new Priced(lines, subtotal, discountCents, subtotal - discountCents);
  }

  /** Extras (toppings, add-ons) are not prepared as separate orders unless the owner says so. */
  public static boolean inOrderQueue(Map<String, Object> product) {
    Object q = product.get("orderQueue");
    return q instanceof Boolean b ? b : !"extras".equals(product.get("category"));
  }

  public static double discountPercent(long discountCents, long subtotalCents) {
    return subtotalCents == 0 ? 0 : (discountCents * 100.0) / subtotalCents;
  }

  // ------------------------------------------------------------------ payments

  public record Settled(String method, Long cashCents, Long amountReceivedCents, Long changeCents) {
    public Map<String, Object> toMap() {
      Map<String, Object> m = new LinkedHashMap<>();
      m.put("method", method);
      if (cashCents != null) m.put("cashCents", cashCents);
      if (amountReceivedCents != null) m.put("amountReceivedCents", amountReceivedCents);
      if (changeCents != null) m.put("changeCents", changeCents);
      return m;
    }
  }

  /**
   * Validates the payment and returns change. Card/EFT pay the whole total;
   * cash must cover it. A split pays cashCents in cash and the rest by card or
   * EFT. If the cash part now covers everything (prices dropped while
   * offline), the sale becomes a plain cash sale.
   */
  public static Settled settlePayment(String method, long totalCents, Long amountReceivedCents, Long cashCents) {
    boolean split = !"cash".equals(method) && cashCents != null && cashCents != 0;
    if (!"cash".equals(method) && !split) return new Settled(method, null, null, null);
    if (split && cashCents < 0) throw error("The cash part looks wrong");
    long cashDue = split ? Math.min(cashCents, totalCents) : totalCents;
    if (amountReceivedCents == null || amountReceivedCents < cashDue) {
      throw error(split ? "Cash received must be at least the cash part" : "Cash received must be at least the order total");
    }
    if (amountReceivedCents > cashDue + 200_000) throw error("Cash received looks wrong (more than R2,000 change)");
    long change = amountReceivedCents - cashDue;
    return split && cashDue < totalCents
        ? new Settled(method, cashDue, amountReceivedCents, change)
        : new Settled("cash", null, amountReceivedCents, change);
  }

  public record Part(String method, long amountCents) {}

  /** How a sale's total was paid, split by method. Plain sales have one part. */
  public static List<Part> paymentParts(Map<String, Object> payment, long totalCents) {
    String method = str(payment.get("method"));
    if ("cash".equals(method)) return List.of(new Part("cash", totalCents));
    long cash = Math.min(cents(payment.get("cashCents")), totalCents);
    return cash > 0 ? List.of(new Part("cash", cash), new Part(method, totalCents - cash)) : List.of(new Part(method, totalCents));
  }

  public static long cashPartCents(Map<String, Object> payment, long totalCents) {
    return paymentParts(payment, totalCents).stream().filter(p -> p.method().equals("cash")).mapToLong(Part::amountCents).sum();
  }

  /** "cash", "card", or "cash + card" */
  public static String paymentLabel(Map<String, Object> payment) {
    String method = str(payment.get("method"));
    return !"cash".equals(method) && cents(payment.get("cashCents")) > 0 ? "cash + " + method : method;
  }

  // ------------------------------------------------------------------ recipes and stock

  public record Usage(String ingredientId, double quantity, long costCents) {}

  public record UsageResult(List<Usage> usage, long costCents) {}

  /** Expected ingredient usage and cost for sale lines, from product recipes. */
  public static UsageResult ingredientUsage(List<Map<String, Object>> lines, Map<String, Map<String, Object>> recipes, Map<String, Map<String, Object>> ingredients) {
    Map<String, Double> qty = new LinkedHashMap<>();
    for (Map<String, Object> line : lines) {
      Map<String, Object> recipe = recipes.get(str(line.get("productId")));
      if (recipe == null) continue;
      for (Map<String, Object> r : list(recipe.get("lines"))) {
        double q = num(r.get("quantity"));
        if (!(q > 0)) continue;
        qty.merge(str(r.get("ingredientId")), q * num(line.get("quantity")), (a, b) -> roundQty(a + b));
      }
    }
    List<Usage> usage = new ArrayList<>();
    long total = 0;
    for (var e : qty.entrySet()) {
      double q = roundQty(e.getValue());
      Map<String, Object> ing = ingredients.get(e.getKey());
      long cost = Math.round(q * num(ing == null ? null : ing.get("unitCostCents")));
      usage.add(new Usage(e.getKey(), q, cost));
      total += cost;
    }
    return new UsageResult(usage, total);
  }

  public static boolean isLowStock(Map<String, Object> i) {
    return Boolean.TRUE.equals(i.get("active")) && num(i.get("currentQty")) <= num(i.get("reorderLevel"));
  }

  /** Suggested order quantity: top the item up to twice its reorder level. */
  public static long reorderQty(double currentQty, double reorderLevel) {
    double target = Math.max(reorderLevel * 2, reorderLevel + 1);
    return Math.max(0, (long) Math.ceil(target - Math.max(currentQty, 0)));
  }

  public record Clamped(double applied, double newQty, double shortfall, boolean ranOut) {}

  /**
   * Stock never goes below zero. A removal larger than what is on hand empties
   * the item and reports the rest as a shortfall. Older negative balances count as zero.
   */
  public static Clamped clampStockChange(double currentQty, double qtyChange) {
    double before = Math.max(roundQty(currentQty), 0);
    double requested = roundQty(qtyChange);
    double applied = before + requested < 0 ? -before : requested;
    double newQty = Math.max(roundQty(before + applied), 0);
    return new Clamped(roundQty(applied), roundQty(newQty), roundQty(applied - requested), before > 0 && newQty == 0);
  }

  public static Map<String, Object> stockCountLine(Map<String, Object> ingredient, double countedQty) {
    if (!(countedQty >= 0) || !Double.isFinite(countedQty)) throw error("Invalid count for " + ingredient.get("name"));
    double current = num(ingredient.get("currentQty"));
    double variance = roundQty(countedQty - current);
    Map<String, Object> line = new LinkedHashMap<>();
    line.put("ingredientId", ingredient.get("id"));
    line.put("ingredientName", ingredient.get("name"));
    line.put("unit", ingredient.get("unit"));
    line.put("theoreticalQty", roundQty(current));
    line.put("countedQty", roundQty(countedQty));
    line.put("varianceQty", variance);
    line.put("varianceCents", Math.round(variance * num(ingredient.get("unitCostCents"))));
    return line;
  }

  // ------------------------------------------------------------------ cash

  /** opening float + cash sales − cash refunds − approved cash expenses − cash paid out */
  public static long expectedCash(Map<String, Object> s) {
    return cents(s.get("openingFloatCents")) + cents(s.get("cashSalesCents")) - cents(s.get("cashRefundsCents"))
        - cents(s.get("approvedCashExpensesCents")) - cents(s.get("cashPayoutsCents"));
  }

  public record CashClose(long expectedCashCents, long differenceCents, boolean requiresExplanation, boolean isAlert) {}

  public static CashClose reconcileCash(Map<String, Object> session, long countedCashCents, long alertThresholdCents) {
    long expected = expectedCash(session);
    long diff = countedCashCents - expected;
    return new CashClose(expected, diff, diff != 0, Math.abs(diff) > alertThresholdCents);
  }

  // ------------------------------------------------------------------ time and text

  public record SoldAt(long atMillis, boolean offline) {}

  /** Queued offline sales carry the device time; it must be in the past (small skew allowed) and at most 24 h old. */
  public static SoldAt resolveSoldAt(Long soldAtMillis, long nowMillis) {
    if (soldAtMillis == null) return new SoldAt(nowMillis, false);
    if (soldAtMillis > nowMillis + 5 * 60_000) throw error("Sale time is in the future – check the phone clock");
    if (nowMillis - soldAtMillis > MAX_OFFLINE_MS) throw error("Offline sale is older than 24 hours – ask the owner to record it");
    long at = Math.min(soldAtMillis, nowMillis);
    return new SoldAt(at, nowMillis - at > 2 * 60_000);
  }

  public static String requireText(Object value, String field, int min, int max) {
    if (!(value instanceof String s) || s.trim().length() < min || s.trim().length() > max) {
      throw error(field + " is required (" + min + "–" + max + " characters)");
    }
    return s.trim();
  }

  public static String optionalText(Object value, String field, int max) {
    if (value == null || "".equals(value)) return null;
    if (!(value instanceof String s) || s.length() > max) throw error(field + " must be at most " + max + " characters");
    String t = s.trim();
    return t.isEmpty() ? null : t;
  }

  /** Converts a South African number (082 123 4567, +27 82…) to WhatsApp's 27821234567 form. */
  public static String waPhone(String phone) {
    String d = phone == null ? "" : phone.replaceAll("\\D", "");
    if (d.matches("^0\\d{9}$")) return "27" + d.substring(1);
    if (d.matches("^27\\d{9}$")) return d;
    return null;
  }

  /** "R 1 234,50" like the app (en-ZA). */
  public static String formatZar(long cents) {
    String sign = cents < 0 ? "-" : "";
    long abs = Math.abs(cents);
    String whole = String.format("%,d", abs / 100).replace(',', ' ');
    return sign + "R " + whole + "," + String.format("%02d", abs % 100);
  }

  public static String centsToRandString(long cents) {
    String sign = cents < 0 ? "-" : "";
    long abs = Math.abs(cents);
    return sign + (abs / 100) + "." + String.format("%02d", abs % 100);
  }

  /** "2× Russian Kota, 1× Chips" */
  public static String itemsText(List<Map<String, Object>> lines) {
    List<String> parts = new ArrayList<>();
    for (Map<String, Object> l : lines) parts.add(cents(l.get("quantity")) + "× " + l.get("name"));
    return String.join(", ", parts);
  }
}
