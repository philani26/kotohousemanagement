package za.co.kotahouse.actions;

import static za.co.kotahouse.domain.Domain.cents;
import static za.co.kotahouse.domain.Domain.formatZar;
import static za.co.kotahouse.domain.Domain.num;
import static za.co.kotahouse.domain.Domain.str;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.springframework.stereotype.Component;
import za.co.kotahouse.common.Days;
import za.co.kotahouse.domain.Domain;
import za.co.kotahouse.settings.Settings;
import za.co.kotahouse.shop.Caller;
import za.co.kotahouse.store.Op;
import za.co.kotahouse.store.Query;
import za.co.kotahouse.store.Store;

/**
 * Changes shared by several actions (port of effects.ts and helpers in
 * common.ts). Call inside the action's transaction, after its reads.
 */
@Component
public class Effects {
  public static final String EXPENSE_INVENTORY_CATEGORY = "Ingredients & stock";

  private final Store store;
  private final Notifier notifier;

  public Effects(Store store, Notifier notifier) {
    this.store = store;
    this.notifier = notifier;
  }

  public static String todayKey(Settings s) {
    return Days.dayKey(Instant.now(), s.timezone());
  }

  /** Merges counter increments (nested maps allowed) into a day's stats. */
  public void bumpStats(String b, String dayKey, Map<String, Object> increments) {
    Map<String, Object> m = new LinkedHashMap<>(increments);
    m.put("dayKey", dayKey);
    store.merge(b, "dailyStats", dayKey, m);
  }

  /** The open shift a caller works against (cashiers: their own; owners: any), locked for this transaction. */
  public Optional<Map<String, Object>> findOpenShift(Caller c) {
    Query.Builder q = Query.of("shifts").where("status", "==", "open");
    if ("employee".equals(c.role())) q.where("employeeId", "==", c.uid());
    return store.listForUpdate(c.businessId(), q.limit(1).build()).stream().findFirst();
  }

  /** The actor of a change: a person, or the system (null caller). */
  public record StockChange(
      Map<String, Object> ingredient,
      double qtyChange,
      String type,
      String reason,
      String refType,
      String refId,
      String shiftId,
      /** human label for alerts, e.g. "Receipt #12" */
      String label,
      /** purchases carry their own cost */
      Long unitCostCents) {}

  /**
   * Appends a stock ledger entry and sets the new balance. Stock never goes
   * below zero: a removal larger than what is on hand empties the item, records
   * the rest as a shortfall and alerts the owner. Returns the value at cost of
   * what was applied.
   */
  public long applyStockChange(String b, Caller actor, Settings settings, StockChange ch, Map<String, Object> extraIngredientFields) {
    Map<String, Object> ing = ch.ingredient();
    Domain.Clamped c = Domain.clampStockChange(num(ing.get("currentQty")), ch.qtyChange());
    long unitCost = ch.unitCostCents() != null ? ch.unitCostCents() : cents(ing.get("unitCostCents"));
    long value = Math.round(Math.abs(c.applied()) * unitCost);
    Map<String, Object> mv = new LinkedHashMap<>();
    mv.put("ingredientId", ing.get("id"));
    mv.put("ingredientName", ing.get("name"));
    mv.put("type", ch.type());
    mv.put("qtyChange", c.applied());
    mv.put("unitCostCents", unitCost);
    mv.put("valueCents", value);
    if (ch.reason() != null) mv.put("reason", ch.reason());
    if (c.shortfall() != 0) mv.put("shortfallQty", c.shortfall());
    if (ch.refType() != null) {
      mv.put("refType", ch.refType());
      mv.put("refId", ch.refId());
    }
    mv.put("shiftId", ch.shiftId());
    mv.put("createdBy", actor == null ? "system" : actor.uid());
    mv.put("createdByName", actor == null ? "System" : actor.name());
    mv.put("createdAt", Op.serverTime());
    mv.put("dayKey", todayKey(settings));
    store.set(b, "stockMovements", store.newId(), mv);

    Map<String, Object> ingUpdate = new LinkedHashMap<>(extraIngredientFields);
    ingUpdate.put("currentQty", c.newQty());
    store.update(b, "ingredients", str(ing.get("id")), ingUpdate);

    if (c.ranOut() || c.shortfall() != 0) {
      String by = actor == null ? "System" : actor.name();
      Map<String, String> kinds = Map.of("sale", "Sale", "wastage", "Wastage", "staffMeal", "Staff meal", "complimentary", "Free item", "adjustment", "Stock correction");
      String what = ch.label() != null ? ch.label() : kinds.getOrDefault(ch.type(), ch.type());
      String unit = str(ing.get("unit"));
      String name = str(ing.get("name"));
      double reorderLevel = num(ing.get("reorderLevel"));
      var a = Notifier.alert("outOfStock", "critical", "Out of stock: " + name)
          .message(c.shortfall() != 0
              ? name + " is at 0 but " + qty(c.shortfall()) + " " + unit + " more was needed. The stock in the app is probably missing a delivery."
              : name + " has run out (0 " + unit + " left).")
          .detail("Item", name)
          .detail("In stock now", "0 " + unit, "bad")
          .detail("Emptied by", what + " at " + Days.localTime(Instant.now(), settings.timezone()));
      if (c.shortfall() != 0) a.detail("Needed but not in stock", qty(c.shortfall()) + " " + unit, "bad");
      a.detail("Reorder level", qty(reorderLevel) + " " + unit)
          .detail("Suggested order", Domain.reorderQty(0, reorderLevel) + " " + unit)
          .detail("Cost per unit", formatZar(cents(ing.get("unitCostCents"))))
          .actor(by)
          .action(c.shortfall() != 0
              ? "If you still have it on the shelf, a delivery was not recorded: add it with Stock › + Add. Otherwise reorder now – Stock › Levels has a WhatsApp order."
              : "Reorder now – Stock › Levels has a ready-made WhatsApp order. Products using it are marked \"Out\" on the Sell screen.")
          .link("/stock");
      notifier.notify(b, settings, a, "outOfStock_" + ing.get("id") + "_" + todayKey(settings));
    }
    return value;
  }

  /** "1.5", "2" – quantities as the app shows them */
  public static String qty(double q) {
    return q == Math.rint(q) ? String.valueOf((long) q) : String.valueOf(Domain.roundQty(q));
  }

  /**
   * Applies an approved refund. Cash goes back out of the till that is open now,
   * so the cash part counts against the open cash session.
   */
  public void applyRefund(String b, Map<String, Object> sale, Map<String, Object> openSession, Caller decidedBy, Map<String, Object> newRefund) {
    String saleId = str(sale.get("id"));
    if (newRefund != null) {
      Map<String, Object> refund = new LinkedHashMap<>(newRefund);
      refund.put("decidedBy", decidedBy.uid());
      refund.put("decidedAt", Op.serverTime());
      store.update(b, "sales", saleId, Map.of("status", "refunded", "refund", refund));
    } else {
      store.update(b, "sales", saleId, Map.of("status", "refunded", "refund.decidedBy", decidedBy.uid(), "refund.decidedAt", Op.serverTime()));
    }
    long total = cents(sale.get("totalCents"));
    long cashBack = Domain.cashPartCents(Domain.map(sale.get("payment")), total);
    if (cashBack > 0 && openSession != null) {
      store.update(b, "cashSessions", str(openSession.get("id")), Map.of("cashRefundsCents", Op.inc(cashBack)));
    }
    // Refunds are reported against the day of the original sale.
    bumpStats(b, str(sale.get("dayKey")), Map.of(
        "refundsCents", Op.inc(total), "refundedCogsCents", Op.inc(cents(sale.get("costCents"))), "refundCount", Op.inc(1)));
  }

  /** Approves or rejects an expense and keeps the linked cash session and stats in step. */
  public void applyExpenseDecision(String b, Map<String, Object> expense, Map<String, Object> session, boolean approve, Caller decidedBy, String note) {
    Map<String, Object> decision = new LinkedHashMap<>();
    decision.put("by", decidedBy.uid());
    decision.put("byName", decidedBy.name());
    decision.put("at", Op.serverTime());
    if (note != null) decision.put("note", note);
    store.update(b, "expenses", str(expense.get("id")), Map.of("status", approve ? "approved" : "rejected", "decision", decision));

    long amount = cents(expense.get("amountCents"));
    if (Boolean.TRUE.equals(expense.get("paidFromTill")) && session != null) {
      long approved = cents(session.get("approvedCashExpensesCents")) + (approve ? amount : 0);
      Map<String, Object> update = new LinkedHashMap<>();
      update.put("pendingCashExpensesCents", Op.inc(-amount));
      update.put("approvedCashExpensesCents", approved);
      // An expense approved after the shift closed changes that shift's expected cash.
      if ("closed".equals(session.get("status")) && approve && session.get("countedCashCents") != null) {
        long expected = cents(session.get("expectedCashCents")) - amount;
        update.put("expectedCashCents", expected);
        update.put("differenceCents", cents(session.get("countedCashCents")) - expected);
      }
      store.update(b, "cashSessions", str(session.get("id")), update);
    }
    if (approve) bumpStats(b, str(expense.get("date")), Map.of(expenseStatsField(str(expense.get("category"))), Op.inc(amount)));
  }

  /** Ingredient purchases are inventory (expensed via cost of sales), everything else is operating cost. */
  public static String expenseStatsField(String category) {
    return EXPENSE_INVENTORY_CATEGORY.equals(category) ? "inventoryPurchasesCents" : "operatingExpensesCents";
  }

  /** Reads several records at once, locked; missing ones are skipped. */
  public Map<String, Map<String, Object>> getAllForUpdate(String b, String collection, List<String> ids) {
    Map<String, Map<String, Object>> out = new LinkedHashMap<>();
    for (String id : ids) store.getForUpdate(b, collection, id).ifPresent(d -> out.put(id, d));
    return out;
  }
}
