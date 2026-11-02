package za.co.kotahouse.actions;

import static za.co.kotahouse.domain.Domain.cents;
import static za.co.kotahouse.domain.Domain.formatZar;
import static za.co.kotahouse.domain.Domain.itemsText;
import static za.co.kotahouse.domain.Domain.map;
import static za.co.kotahouse.domain.Domain.num;
import static za.co.kotahouse.domain.Domain.str;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.jdbc.core.simple.JdbcClient;
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
import za.co.kotahouse.domain.Domain;
import za.co.kotahouse.domain.Yoco;
import za.co.kotahouse.settings.Loyalty;
import za.co.kotahouse.settings.Settings;
import za.co.kotahouse.settings.SettingsService;
import za.co.kotahouse.shop.Caller;
import za.co.kotahouse.store.Op;
import za.co.kotahouse.store.Store;
import za.co.kotahouse.store.Ts;

/** Sales, refunds and payment checks (port of sales.ts). */
@RestController
@RequestMapping("/api/rpc")
@Tag(name = "Sales")
public class SaleActions {
  private static final Pattern SALE_ID = Pattern.compile("^[A-Za-z0-9_-]{16,64}$");
  private static final Set<String> METHODS = Set.of("cash", "card", "eft");

  private final Ctx ctx;
  private final Store store;
  private final SettingsService settingsService;
  private final Effects effects;
  private final Notifier notifier;
  private final AuditLog audit;
  private final JdbcClient db;

  public SaleActions(Ctx ctx, Store store, SettingsService settingsService, Effects effects, Notifier notifier, AuditLog audit, JdbcClient db) {
    this.ctx = ctx;
    this.store = store;
    this.settingsService = settingsService;
    this.effects = effects;
    this.notifier = notifier;
    this.audit = audit;
    this.db = db;
  }

  @Operation(summary = "Record a sale", description = """
      The server prices the sale from the menu, works out change, cost and stock, and saves it in one transaction. \
      saleId is made by the app: sending the same sale again returns the existing receipt (duplicate: true), never a second sale. \
      Offline sales send soldAtMillis (when it was rung up, at most 24 h ago).""")
  @PostMapping("/recordSale")
  @Transactional
  public Map<String, Object> recordSale(@AuthenticationPrincipal Jwt jwt, @RequestBody Map<String, Object> data) {
    Body d = Body.of(data);
    Caller c = ctx.require(jwt, d);
    String saleId = d.str("saleId");
    if (!SALE_ID.matcher(saleId).matches()) throw ApiException.invalid("Invalid sale id");
    Body pay = d.obj("payment");
    String method = pay.str("method");
    if (!METHODS.contains(method)) throw ApiException.invalid("Choose a payment method");
    String reference = pay.optText("reference", "Payment reference", 60);
    String discountReason = d.optText("discountReason", "Discount reason", 120);
    Body customerIn = d.has("customer") ? d.obj("customer") : null;
    String customerPhone = customerIn == null ? null : Loyalty.normalisePhone(customerIn.raw("phone"));
    if (customerIn != null && customerPhone == null) throw ApiException.invalid("Enter the customer's cellphone number, e.g. 082 123 4567");
    String customerName = customerIn == null ? null : customerIn.optText("name", "Customer name", 60);
    Domain.SoldAt soldAt = Domain.resolveSoldAt(d.optLong("soldAtMillis"), System.currentTimeMillis());
    String b = c.businessId();

    // ---- reads ----
    var existing = store.getForUpdate(b, "sales", saleId);
    if (existing.isPresent()) {
      var s = existing.get();
      if (!c.uid().equals(s.get("employeeId"))) throw ApiException.exists("Duplicate sale id");
      return result(saleId, cents(s.get("receiptNo")), cents(s.get("totalCents")), cents(map(s.get("payment")).get("changeCents")), true);
    }
    Map<String, Object> shift = effects.findOpenShift(c).orElseThrow(() -> ApiException.precondition("Open a shift before recording sales"));
    if ("employee".equals(c.role()) && !c.uid().equals(shift.get("employeeId"))) throw ApiException.denied("This is not your shift");

    List<Domain.CartItem> items = new ArrayList<>();
    Set<String> productIds = new LinkedHashSet<>();
    for (Map<String, Object> i : d.objects("items")) {
      Object q = i.get("quantity");
      int qty = q instanceof Number n && n.doubleValue() == Math.rint(n.doubleValue()) ? n.intValue() : 0;
      items.add(new Domain.CartItem(str(i.get("productId")), qty));
      productIds.add(str(i.get("productId")));
    }
    if (productIds.isEmpty()) throw Domain.error("The order is empty");
    Map<String, Map<String, Object>> products = new LinkedHashMap<>();
    Map<String, Map<String, Object>> recipes = new LinkedHashMap<>();
    for (String id : productIds) {
      store.get(b, "products", id).ifPresent(p -> products.put(id, p));
      store.get(b, "recipes", id).ifPresent(r -> recipes.put(id, r));
    }
    Set<String> ingredientIds = new LinkedHashSet<>();
    recipes.values().forEach(r -> Domain.list(r.get("lines")).forEach(l -> ingredientIds.add(str(l.get("ingredientId")))));
    Map<String, Map<String, Object>> ingredients = effects.getAllForUpdate(b, "ingredients", List.copyOf(ingredientIds));
    Settings settings = settingsService.read(b);

    String yocoId = pay.has("yocoCheckoutId") ? pay.str("yocoCheckoutId") : null;
    if (yocoId != null && !"card".equals(method)) throw ApiException.invalid("A Yoco payment is a card payment");
    Map<String, Object> yoco = yocoId == null ? null : store.getForUpdate(b, "yocoCheckouts", yocoId).orElse(null);
    Map<String, Object> customer = customerPhone == null ? null : store.getForUpdate(b, "customers", customerPhone).orElse(null);

    // ---- business rules ----
    Domain.Priced cart = Domain.priceCart(items, products, d.has("discountCents") ? cents(d.raw("discountCents")) : 0);
    double pct = Domain.discountPercent(cart.discountCents(), cart.subtotalCents());
    if (cart.discountCents() > 0) {
      if (discountReason == null) throw Domain.error("Give a reason for the discount");
      if ("employee".equals(c.role()) && pct > settings.maxEmployeeDiscountPercent()) {
        throw ApiException.denied("Discounts above " + Effects.qty(settings.maxEmployeeDiscountPercent()) + "% need the owner");
      }
    }
    // Stamp-card reward on top of the cashier's discount (not limited by the cashier's discount limit).
    Loyalty loyaltyRules = Loyalty.of(settings.section("loyalty"));
    boolean redeem = customerIn != null && customerIn.bool("redeemReward");
    Loyalty.Outcome loyalty = loyaltyRules.outcome(customer == null ? null : (Number) customer.get("stamps"), cart.totalCents(), redeem);
    // Offline sales were already charged: record them anyway (the total-changed alert flags the difference).
    if (redeem && loyalty.rewardCents() == 0 && !soldAt.offline()) {
      throw Domain.error(loyaltyRules.enabled() ? "This customer's stamp card isn't full yet" : "The stamp card is switched off");
    }
    Domain.Priced priced = cart.withReward(loyalty.rewardCents());
    Domain.Settled payment = Domain.settlePayment(method, priced.totalCents(), pay.optLong("amountReceivedCents"), pay.optLong("cashCents"));
    List<Domain.Part> parts = Domain.paymentParts(payment.toMap(), priced.totalCents());
    if (yocoId != null) {
      long cardPart = parts.stream().filter(p -> p.method().equals("card")).mapToLong(Domain.Part::amountCents).sum();
      String problem = Yoco.checkoutProblem(yoco, saleId, cardPart);
      if (problem != null) throw Domain.error(problem);
    }
    String paidBy = Domain.paymentLabel(payment.toMap());
    Domain.UsageResult usage = Domain.ingredientUsage(priced.lines(), recipes, ingredients);

    // ---- writes ----
    long receiptNo = db.sql("update businesses set receipt_counter = receipt_counter + 1 where id = :b returning receipt_counter")
        .param("b", b).query(Long.class).single();
    Instant now = Instant.ofEpochMilli(soldAt.atMillis());
    String dayKey = Days.dayKey(now, settings.timezone());
    Long expectedTotal = d.optLong("expectedTotalCents");
    boolean priceChanged = expectedTotal != null && expectedTotal != priced.totalCents();

    Map<String, Object> paymentDoc = payment.toMap();
    if (reference != null) paymentDoc.put("reference", reference);
    if (yoco != null) {
      // a Yoco payment was confirmed by Yoco's webhook, so it is verified straight away
      String paymentId = str(yoco.get("paymentId"));
      paymentDoc.put("reference", paymentId == null || paymentId.isEmpty() ? yoco.get("id") : paymentId);
      paymentDoc.put("yocoCheckoutId", yoco.get("id"));
    }
    paymentDoc.put("verified", "cash".equals(payment.method()) || yoco != null);

    Map<String, Object> sale = new LinkedHashMap<>();
    sale.put("receiptNo", receiptNo);
    sale.put("shiftId", shift.get("id"));
    sale.put("employeeId", c.uid());
    sale.put("employeeName", c.name());
    sale.put("lines", priced.lines());
    sale.put("subtotalCents", priced.subtotalCents());
    sale.put("discountCents", priced.discountCents());
    if (discountReason != null) sale.put("discountReason", discountReason);
    sale.put("totalCents", priced.totalCents());
    if (customerPhone != null) {
      sale.put("customerPhone", customerPhone);
      String name = customerName != null ? customerName : customer == null ? null : str(customer.get("name"));
      if (name != null && !name.isEmpty()) sale.put("customerName", name);
    }
    if (loyalty.rewardCents() > 0) sale.put("rewardCents", loyalty.rewardCents());
    sale.put("costCents", usage.costCents());
    sale.put("payment", paymentDoc);
    sale.put("status", "completed");
    sale.put("dayKey", dayKey);
    if (soldAt.offline()) sale.put("offline", true);
    sale.put("soldAt", Ts.of(now));
    sale.put("createdAt", Op.serverTime());
    store.create(b, "sales", saleId, sale); // insert-only: a concurrent retry can never overwrite

    if (yoco != null) store.update(b, "yocoCheckouts", yocoId, Map.of("usedBySale", saleId));
    if (customerPhone != null) {
      Map<String, Object> cust = new LinkedHashMap<>();
      cust.put("phone", customerPhone);
      cust.put("name", customerName != null ? customerName : customer == null ? "" : String.valueOf(customer.getOrDefault("name", "")));
      cust.put("visits", (customer == null ? 0 : cents(customer.get("visits"))) + 1);
      cust.put("spentCents", (customer == null ? 0 : cents(customer.get("spentCents"))) + priced.totalCents());
      cust.put("stamps", loyalty.stampsAfter());
      cust.put("rewardsRedeemed", (customer == null ? 0 : cents(customer.get("rewardsRedeemed"))) + (loyalty.rewardCents() > 0 ? 1 : 0));
      cust.put("firstVisitMillis", customer == null ? now.toEpochMilli() : cents(customer.get("firstVisitMillis")));
      cust.put("lastVisitMillis", now.toEpochMilli());
      store.set(b, "customers", customerPhone, cust);
    }

    for (Domain.Usage u : usage.usage()) {
      Map<String, Object> ing = ingredients.get(u.ingredientId());
      if (ing == null) continue;
      boolean wasLow = Domain.isLowStock(ing);
      effects.applyStockChange(b, c, settings,
          new Effects.StockChange(ing, -u.quantity(), "sale", null, "sale", saleId, str(shift.get("id")), "Receipt #" + receiptNo, null), Map.of());
      double after = Domain.clampStockChange(num(ing.get("currentQty")), -u.quantity()).newQty();
      Map<String, Object> afterIng = new LinkedHashMap<>(ing);
      afterIng.put("currentQty", after);
      // reaching 0 raises the out-of-stock alert instead
      if (!wasLow && Domain.isLowStock(afterIng) && after > 0) {
        String unit = str(ing.get("unit"));
        double reorder = num(ing.get("reorderLevel"));
        notifier.notify(b, settings, Notifier.alert("lowStock", "warning", "Low stock: " + ing.get("name"))
            .message(ing.get("name") + " is down to " + Effects.qty(after) + " " + unit + " (reorder level " + Effects.qty(reorder) + ").")
            .detail("Item", str(ing.get("name")))
            .detail("Left (expected)", Effects.qty(after) + " " + unit, "bad")
            .detail("Reorder level", Effects.qty(reorder) + " " + unit)
            .detail("Suggested order", Math.max(0, (long) Math.ceil(reorder * 2 - Math.max(after, 0))) + " " + unit)
            .detail("Value left at cost", formatZar(Math.round(Math.max(after, 0) * num(ing.get("unitCostCents")))))
            .detail("Triggered by", "Receipt #" + receiptNo + " at " + Days.localTime(now, settings.timezone()))
            .actor(c.name())
            .action("Order more from your supplier – Stock › Levels has a ready-made WhatsApp order.")
            .link("/stock"));
      }
    }

    Map<String, Object> sessionInc = new LinkedHashMap<>();
    for (Domain.Part p : parts) sessionInc.put(p.method() + "SalesCents", Op.inc(p.amountCents()));
    store.update(b, "cashSessions", str(shift.get("cashSessionId")), sessionInc);
    store.update(b, "shifts", str(shift.get("id")), Map.of("lastSaleAt", Ts.of(now)));

    Map<String, Object> productInc = new LinkedHashMap<>();
    for (Map<String, Object> l : priced.lines()) {
      productInc.put(str(l.get("productId")), Map.of("name", l.get("name"), "qty", Op.inc(num(l.get("quantity"))), "revenueCents", Op.inc(cents(l.get("lineTotalCents")))));
    }
    Map<String, Object> byMethod = new LinkedHashMap<>();
    for (Domain.Part p : parts) byMethod.put(p.method(), Op.inc(p.amountCents()));
    effects.bumpStats(b, dayKey, Map.of(
        "grossSalesCents", Op.inc(priced.totalCents()),
        "discountsCents", Op.inc(priced.discountCents()),
        "orders", Op.inc(1),
        "cogsCents", Op.inc(usage.costCents()),
        "byMethod", byMethod,
        "products", productInc,
        "hourly", Map.of(String.format("%02d", Days.localHour(now, settings.timezone())), Op.inc(priced.totalCents()))));

    if (loyalty.rewardCents() > 0) audit.record(c, "loyalty.redeemed", "sales", saleId, Map.of("customer", customerPhone, "rewardCents", loyalty.rewardCents()));
    if (cart.discountCents() > 0) {
      audit.record(c, "sale.discounted", "sales", saleId, mapOf("discountCents", cart.discountCents(), "percent", Math.round(pct), "reason", discountReason));
      if (pct >= settings.threshold("discountAlertPercent")) {
        notifier.notify(b, settings, Notifier.alert("largeDiscount", "warning", "Discount of " + Math.round(pct) + "% given")
            .message(c.name() + " discounted receipt #" + receiptNo + " by " + formatZar(cart.discountCents()) + ": " + discountReason)
            .detail("Receipt", "#" + receiptNo + " at " + Days.localTime(now, settings.timezone()))
            .detail("Items", itemsText(priced.lines()))
            .detail("Full price", formatZar(cart.subtotalCents()))
            .detail("Discount", formatZar(cart.discountCents()) + " (" + Math.round(pct) + "%)", "bad")
            .detail("Customer paid", formatZar(priced.totalCents()) + " by " + paidBy)
            .detail("Reason given", discountReason == null ? "" : discountReason)
            .actor(c.name())
            .action("Check the reason is genuine. Repeated discounts by one person are worth a conversation.")
            .link("/sales"));
      }
    }
    if (priceChanged) {
      notifier.notify(b, settings, Notifier.alert("priceMismatch", "warning", "Offline sale #" + receiptNo + " total changed")
          .message(c.name() + " charged " + formatZar(expectedTotal) + " while offline, but current prices make it " + formatZar(priced.totalCents()) + ". Check the till.")
          .detail("Receipt", "#" + receiptNo)
          .detail("Sold at (offline)", Days.localTime(now, settings.timezone()))
          .detail("Items", itemsText(priced.lines()))
          .detail("Charged to customer", formatZar(expectedTotal))
          .detail("Recorded at current prices", formatZar(priced.totalCents()))
          .detail("Difference", formatZar(priced.totalCents() - expectedTotal), "bad")
          .actor(c.name())
          .action("Prices changed while the phone was offline. Expect the till to differ by this amount at cash-up.")
          .link("/sales"));
    }
    Map<String, Object> details = mapOf("receiptNo", receiptNo, "totalCents", priced.totalCents(), "method", paidBy);
    if (soldAt.offline()) {
      details.put("offline", true);
      details.put("soldAt", now.toString());
    }
    if (priceChanged) details.put("chargedCents", expectedTotal);
    audit.record(c, "sale.recorded", "sales", saleId, details);
    return result(saleId, receiptNo, priced.totalCents(), payment.changeCents() == null ? 0 : payment.changeCents(), false);
  }

  private static Map<String, Object> result(String saleId, long receiptNo, long total, long change, boolean duplicate) {
    return mapOf("saleId", saleId, "receiptNo", receiptNo, "totalCents", total, "changeCents", change, "duplicate", duplicate);
  }

  static Map<String, Object> mapOf(Object... kv) {
    Map<String, Object> m = new LinkedHashMap<>();
    for (int i = 0; i < kv.length; i += 2) m.put((String) kv[i], kv[i + 1]);
    return m;
  }

  @Operation(summary = "Refund a sale", description = "A cashier's refund waits for the owner's approval; the owner's is applied straight away. Cash goes back out of the open till.")
  @PostMapping("/requestRefund")
  @Transactional
  public Map<String, Object> requestRefund(@AuthenticationPrincipal Jwt jwt, @RequestBody Map<String, Object> data) {
    Body d = Body.of(data);
    Caller c = ctx.require(jwt, d);
    String reason = d.text("reason", "Refund reason", 3, 200);
    String b = c.businessId();
    String saleId = d.str("saleId");
    Map<String, Object> sale = store.getForUpdate(b, "sales", saleId).orElseThrow(() -> ApiException.notFound("Sale not found"));
    if (!"completed".equals(sale.get("status"))) throw ApiException.precondition("This sale has already been refunded or is awaiting approval");
    if ("employee".equals(c.role()) && !c.uid().equals(sale.get("employeeId"))) throw ApiException.denied("You can only refund your own sales");
    Settings settings = settingsService.read(b);
    var shift = effects.findOpenShift(c);
    Map<String, Object> session = shift.isEmpty() ? null : store.getForUpdate(b, "cashSessions", str(shift.get().get("cashSessionId"))).orElse(null);
    long total = cents(sale.get("totalCents"));
    Map<String, Object> payment = map(sale.get("payment"));
    long cashBack = Domain.cashPartCents(payment, total);
    if (cashBack > 0 && session == null) throw ApiException.precondition("A shift must be open to pay back a cash refund");
    String label = Domain.paymentLabel(payment);

    String approvalId = store.newId();
    Map<String, Object> approval = new LinkedHashMap<>();
    approval.put("type", "refund");
    approval.put("status", c.isOwner() ? "approved" : "pending");
    approval.put("refId", saleId);
    approval.put("summary", "Refund receipt #" + cents(sale.get("receiptNo")) + " (" + label + ") – " + reason);
    approval.put("amountCents", total);
    approval.put("payload", Map.of("reason", reason, "method", label));
    approval.put("requestedBy", c.uid());
    approval.put("requestedByName", c.name());
    approval.put("requestedAt", Op.serverTime());
    if (c.isOwner()) {
      approval.put("decidedBy", c.uid());
      approval.put("decidedByName", c.name());
      approval.put("decidedAt", Op.serverTime());
      approval.put("note", "Owner refund");
    }
    store.set(b, "approvals", approvalId, approval);
    Map<String, Object> refund = mapOf("reason", reason, "requestedBy", c.uid(), "requestedAt", Ts.now(), "approvalId", approvalId);
    if (c.isOwner()) {
      effects.applyRefund(b, sale, session, c, refund);
    } else {
      store.update(b, "sales", saleId, Map.of("status", "refundPending", "refund", refund));
      Object soldAt = sale.get("soldAt") != null ? sale.get("soldAt") : sale.get("createdAt");
      Long soldMs = Ts.millis(soldAt);
      String method = str(payment.get("method"));
      notifier.notify(b, settings, Notifier.alert("refundRequest", total >= settings.threshold("refundAlertCents") ? "critical" : "warning", "Refund requested: " + formatZar(total))
          .message(c.name() + " asked to refund receipt #" + cents(sale.get("receiptNo")) + ": " + reason)
          .detail("Receipt", "#" + cents(sale.get("receiptNo")))
          .detail("Originally sold", (soldMs == null ? "" : Days.localTime(Instant.ofEpochMilli(soldMs), settings.timezone())) + " by " + sale.get("employeeName"))
          .detail("Items", itemsText(Domain.list(sale.get("lines"))))
          .detail("Refund amount", formatZar(total), "bad")
          .detail("Paid by", label.toUpperCase())
          .detail("Reason given", reason)
          .detail("Requested", Days.localTime(Instant.now(), settings.timezone()))
          .actor(c.name())
          .action("cash".equals(method)
              ? "Approve or reject in Approvals. If approved, the cash comes out of the till that is open now."
              : cashBack > 0
                  ? "Approve or reject in Approvals. If approved, " + formatZar(cashBack) + " comes out of the till; the " + method + " part must be refunded on the card machine or by bank transfer."
                  : "Approve or reject in Approvals. Card/EFT refunds must also be done on the card machine or by bank transfer.")
          .link("/approvals"));
    }
    audit.record(c, c.isOwner() ? "refund.applied" : "refund.requested", "sales", saleId, Map.of("amountCents", total, "reason", reason));
    return Map.of("approvalId", approvalId);
  }

  @Operation(summary = "Mark a card/EFT sale as matched", description = "Owner: the payment was found on the card machine slip or bank statement.")
  @PostMapping("/verifyPayment")
  @Transactional
  public Map<String, Object> verifyPayment(@AuthenticationPrincipal Jwt jwt, @RequestBody Map<String, Object> data) {
    Body d = Body.of(data);
    Caller c = ctx.require(jwt, d, "owner");
    String saleId = d.str("saleId");
    String b = c.businessId();
    Map<String, Object> sale = store.getForUpdate(b, "sales", saleId).orElseThrow(() -> ApiException.notFound("Sale not found"));
    Map<String, Object> payment = map(sale.get("payment"));
    if ("cash".equals(payment.get("method"))) throw ApiException.precondition("Cash sales are reconciled through the cash count");
    boolean verified = d.bool("verified");
    store.update(b, "sales", saleId, Map.of("payment.verified", verified, "payment.verifiedBy", c.uid(), "payment.verifiedAt", Op.serverTime()));
    audit.record(c, verified ? "payment.verified" : "payment.unverified", "sales", saleId, Map.of("method", str(payment.get("method")), "totalCents", cents(sale.get("totalCents"))));
    return Map.of("ok", true);
  }
}
