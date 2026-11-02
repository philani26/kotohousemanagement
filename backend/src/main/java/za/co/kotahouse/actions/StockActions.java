package za.co.kotahouse.actions;

import static za.co.kotahouse.actions.Effects.qty;
import static za.co.kotahouse.domain.Domain.cents;
import static za.co.kotahouse.domain.Domain.formatZar;
import static za.co.kotahouse.domain.Domain.num;
import static za.co.kotahouse.domain.Domain.str;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
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
import za.co.kotahouse.settings.Settings;
import za.co.kotahouse.settings.SettingsService;
import za.co.kotahouse.shop.Caller;
import za.co.kotahouse.store.Op;
import za.co.kotahouse.store.Store;

/** Deliveries, wastage, staff meals and stock corrections (port of stock.ts). */
@RestController
@RequestMapping("/api/rpc")
@Tag(name = "Stock")
public class StockActions {
  private static final Set<String> STAFF_TYPES = Set.of("wastage", "staffMeal", "complimentary");

  private final Ctx ctx;
  private final Store store;
  private final SettingsService settingsService;
  private final Effects effects;
  private final Notifier notifier;
  private final AuditLog audit;

  public StockActions(Ctx ctx, Store store, SettingsService settingsService, Effects effects, Notifier notifier, AuditLog audit) {
    this.ctx = ctx;
    this.store = store;
    this.settingsService = settingsService;
    this.effects = effects;
    this.notifier = notifier;
    this.audit = audit;
  }

  private static double assertQty(Object q, String field, boolean allowNegative) {
    double n = q instanceof Number num ? num.doubleValue() : Double.NaN;
    if (!Double.isFinite(n) || n == 0 || Math.abs(n) > 100_000 || (!allowNegative && n < 0)) {
      throw Domain.error(field + " must be a " + (allowNegative ? "non-zero" : "positive") + " number");
    }
    return Domain.roundQty(n);
  }

  @Operation(summary = "Record a stock delivery", description = """
      Stock goes up. When a different price is entered, the item's cost becomes the weighted average. \
      Cash paid from the till lowers the expected cash at close.""")
  @PostMapping("/recordPurchase")
  @Transactional
  public Map<String, Object> recordPurchase(@AuthenticationPrincipal Jwt jwt, @RequestBody Map<String, Object> data) {
    Body d = Body.of(data);
    Caller c = ctx.require(jwt, d);
    String b = c.businessId();
    List<Map<String, Object>> rawLines = d.objects("lines");
    if (rawLines.isEmpty() || rawLines.size() > 50) throw Domain.error("Add between 1 and 50 items");
    Set<String> ids = new HashSet<>();
    for (Map<String, Object> l : rawLines) ids.add(str(l.get("ingredientId")));
    if (ids.size() != rawLines.size()) throw Domain.error("Each ingredient may appear once");
    long paidFromTill = d.has("paidFromTillCents") ? d.cents("paidFromTillCents", "Cash from till") : 0;
    String invoiceRef = d.optText("invoiceRef", "Invoice number", 60);
    String receiptPath = ApprovalActions.receiptPath(d.optText("receiptPath", "Receipt", 300), c);

    String supplierId = d.has("supplierId") && !d.str("supplierId").isEmpty() ? d.str("supplierId") : null;
    Map<String, Object> supplier = supplierId == null ? null : store.get(b, "suppliers", supplierId).orElse(null);
    if (supplierId != null && supplier == null) throw Domain.error("Unknown supplier");
    Settings settings = settingsService.read(b);
    var shift = effects.findOpenShift(c);
    if (paidFromTill > 0 && shift.isEmpty()) throw ApiException.precondition("A shift must be open to pay from the till");

    List<Map<String, Object>> lines = new ArrayList<>();
    List<Map<String, Object>> loaded = new ArrayList<>();
    for (Map<String, Object> l : rawLines) {
      Map<String, Object> ing = store.getForUpdate(b, "ingredients", str(l.get("ingredientId"))).orElseThrow(() -> Domain.error("Unknown ingredient"));
      double quantity = assertQty(l.get("quantity"), "Quantity of " + ing.get("name"), false);
      // No cost given (e.g. a cashier who doesn't know the price): use the current cost, leaving it unchanged.
      long unitCost = l.get("unitCostCents") == null
          ? cents(ing.get("unitCostCents"))
          : Body.of(l).cents("unitCostCents", "Unit cost of " + ing.get("name"), 0, 10_000_000);
      Map<String, Object> line = new LinkedHashMap<>();
      line.put("ingredientId", ing.get("id"));
      line.put("ingredientName", ing.get("name"));
      line.put("quantity", quantity);
      line.put("unitCostCents", unitCost);
      line.put("lineTotalCents", Math.round(quantity * unitCost));
      lines.add(line);
      loaded.add(ing);
    }
    long total = lines.stream().mapToLong(l -> cents(l.get("lineTotalCents"))).sum();
    if (paidFromTill > total) throw Domain.error("Cash from till cannot be more than the delivery total");

    String purchaseId = store.newId();
    String shiftId = shift.map(s -> str(s.get("id"))).orElse(null);
    Map<String, Object> purchase = new LinkedHashMap<>();
    if (supplier != null) {
      purchase.put("supplierId", supplierId);
      purchase.put("supplierName", supplier.get("name"));
    }
    purchase.put("lines", lines);
    purchase.put("totalCents", total);
    purchase.put("paidFromTillCents", paidFromTill);
    if (invoiceRef != null) purchase.put("invoiceRef", invoiceRef);
    if (receiptPath != null) purchase.put("receiptPath", receiptPath);
    purchase.put("shiftId", shiftId);
    purchase.put("createdBy", c.uid());
    purchase.put("createdByName", c.name());
    purchase.put("createdAt", Op.serverTime());
    purchase.put("dayKey", Effects.todayKey(settings));
    store.set(b, "purchases", purchaseId, purchase);

    for (int i = 0; i < lines.size(); i++) {
      Map<String, Object> line = lines.get(i);
      Map<String, Object> ing = loaded.get(i);
      double onHand = Math.max(num(ing.get("currentQty")), 0);
      double q = num(line.get("quantity"));
      long lineCost = cents(line.get("unitCostCents"));
      long oldCost = cents(ing.get("unitCostCents"));
      long avgCost = Math.round((onHand * oldCost + q * lineCost) / (onHand + q));
      effects.applyStockChange(b, c, settings, new Effects.StockChange(ing, q, "purchase", null, "purchase", purchaseId, shiftId, null, lineCost),
          // only re-average the cost when a different price was entered
          lineCost == oldCost ? Map.of() : Map.of("unitCostCents", avgCost));
    }

    if (paidFromTill > 0 && shift.isPresent()) {
      String sessionId = str(shift.get().get("cashSessionId"));
      Map<String, Object> session = store.getForUpdate(b, "cashSessions", sessionId).orElseThrow();
      List<Object> payouts = new ArrayList<>(Domain.list(session.get("payouts")));
      String supplierName = supplier == null ? null : str(supplier.get("name"));
      payouts.add(Map.of("amountCents", paidFromTill,
          "reason", "Stock delivery" + (supplierName != null ? " – " + supplierName : "") + (invoiceRef != null ? " (" + invoiceRef + ")" : ""),
          "by", c.uid(), "byName", c.name(), "at", System.currentTimeMillis()));
      store.update(b, "cashSessions", sessionId, Map.of("cashPayoutsCents", Op.inc(paidFromTill), "payouts", payouts));
      var a = Notifier.alert("tillPurchase", "info", "Stock paid from till: " + formatZar(paidFromTill))
          .message(c.name() + " recorded a delivery of " + lines.size() + " item(s)" + (supplierName != null ? " from " + supplierName : "") + ".")
          .detail("Supplier", supplierName != null ? supplierName : "Not listed");
      for (Map<String, Object> l : lines) {
        a.detail(str(l.get("ingredientName")), qty(num(l.get("quantity"))) + " × " + formatZar(cents(l.get("unitCostCents"))) + " = " + formatZar(cents(l.get("lineTotalCents"))));
      }
      a.detail("Delivery total", formatZar(total))
          .detail("Cash taken from till", formatZar(paidFromTill), "bad")
          .detail("Invoice / slip", invoiceRef != null ? invoiceRef : receiptPath != null ? "Photo attached" : "None")
          .detail("When", Days.localTime(Instant.now(), settings.timezone()))
          .actor(c.name())
          .action("Check the invoice matches. Stock levels went up and the till cash expected at close went down by this amount.")
          .link("/stock");
      notifier.notify(b, settings, a);
    }
    effects.bumpStats(b, Effects.todayKey(settings), Map.of("inventoryPurchasesCents", Op.inc(total)));
    audit.record(c, "stock.purchase", "purchases", purchaseId, Map.of("totalCents", total, "paidFromTillCents", paidFromTill, "lines", lines.size()));
    return Map.of("purchaseId", purchaseId);
  }

  @Operation(summary = "Wastage, staff meal, free item or stock correction", description = """
      Recorded straight away with a reason. A cashier's correction (adjustment) becomes a request for the owner. \
      Removals can't take more than is in stock.""")
  @PostMapping("/recordStockMovement")
  @Transactional
  public Map<String, Object> recordStockMovement(@AuthenticationPrincipal Jwt jwt, @RequestBody Map<String, Object> data) {
    Body d = Body.of(data);
    Caller c = ctx.require(jwt, d);
    String b = c.businessId();
    String type = d.str("type");
    if (!"adjustment".equals(type) && !STAFF_TYPES.contains(type)) throw Domain.error("Invalid stock movement type");
    double quantity = assertQty(d.raw("quantity"), "Quantity", "adjustment".equals(type));
    String reason = d.text("reason", "Reason", 3, 200);

    Map<String, Object> ing = store.getForUpdate(b, "ingredients", d.str("ingredientId")).orElseThrow(() -> ApiException.notFound("Ingredient not found"));
    Settings settings = settingsService.read(b);
    var shift = effects.findOpenShift(c);
    String shiftId = shift.map(s -> str(s.get("id"))).orElse(null);
    String dayKey = Effects.todayKey(settings);
    String unit = str(ing.get("unit"));
    String name = str(ing.get("name"));

    if ("adjustment".equals(type) && "employee".equals(c.role())) {
      String approvalId = store.newId();
      Map<String, Object> approval = new LinkedHashMap<>();
      approval.put("type", "stockAdjustment");
      approval.put("status", "pending");
      approval.put("refId", ing.get("id"));
      approval.put("summary", name + ": " + (quantity > 0 ? "+" : "") + qty(quantity) + " " + unit + " – " + reason);
      approval.put("amountCents", Math.round(Math.abs(quantity) * num(ing.get("unitCostCents"))));
      Map<String, Object> payload = new LinkedHashMap<>();
      payload.put("ingredientId", ing.get("id"));
      payload.put("qtyChange", quantity);
      payload.put("reason", reason);
      payload.put("shiftId", shiftId);
      approval.put("payload", payload);
      approval.put("requestedBy", c.uid());
      approval.put("requestedByName", c.name());
      approval.put("requestedAt", Op.serverTime());
      store.set(b, "approvals", approvalId, approval);
      audit.record(c, "stock.adjustmentRequested", "ingredients", str(ing.get("id")), Map.of("quantity", quantity, "reason", reason));
      return Map.of("approvalId", approvalId);
    }

    double qtyChange = "adjustment".equals(type) ? quantity : -quantity;
    // Manual removals can't take more than is on hand – stock never goes below zero.
    double onHand = Math.max(num(ing.get("currentQty")), 0);
    if (qtyChange < 0 && -qtyChange > onHand) throw Domain.error("Only " + qty(Domain.roundQty(onHand)) + " " + unit + " of " + name + " in stock");
    long wastedBefore = store.getForUpdate(b, "dailyStats", dayKey).map(s -> cents(s.get("wastageCostCents"))).orElse(0L);
    long value = effects.applyStockChange(b, c, settings, new Effects.StockChange(ing, qtyChange, type, reason, null, null, shiftId, null, null), Map.of());
    switch (type) {
      case "wastage" -> {
        effects.bumpStats(b, dayKey, Map.of("wastageCostCents", Op.inc(value)));
        long limit = (long) settings.threshold("wastageAlertCents");
        if (wastedBefore <= limit && wastedBefore + value > limit) {
          notifier.notify(b, settings, Notifier.alert("excessiveWastage", "warning", "Wastage today is over " + formatZar(limit))
              .message(c.name() + " recorded " + qty(quantity) + " " + unit + " " + name + " wasted (" + reason + "). Total today: " + formatZar(wastedBefore + value) + ".")
              .detail("Item wasted", qty(quantity) + " " + unit + " " + name)
              .detail("Value at cost", formatZar(value), "bad")
              .detail("Reason given", reason)
              .detail("Wastage today so far", formatZar(wastedBefore + value), "bad")
              .detail("Your daily limit", formatZar(limit))
              .detail("When", Days.localTime(Instant.now(), settings.timezone()))
              .actor(c.name())
              .action("See every wastage entry in Stock › History. Change the limit in Settings › Alert thresholds.")
              .link("/stock"));
        }
      }
      case "adjustment" -> effects.bumpStats(b, dayKey, Map.of("stockAdjustmentCents", Op.inc(Math.signum(qtyChange) * value)));
      // staff meals and free items are both stock given away at cost
      default -> effects.bumpStats(b, dayKey, Map.of("staffMealCostCents", Op.inc(value)));
    }
    audit.record(c, "stock." + type, "ingredients", str(ing.get("id")), Map.of("quantity", qtyChange, "reason", reason, "valueCents", value));
    return Map.of();
  }
}
