package za.co.kotahouse.actions;

import static za.co.kotahouse.domain.Domain.cents;
import static za.co.kotahouse.domain.Domain.formatZar;
import static za.co.kotahouse.domain.Domain.str;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
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
import za.co.kotahouse.store.Query;
import za.co.kotahouse.store.Store;
import za.co.kotahouse.store.Ts;

/** Opening the day, cash taken out, and the blind cash-up (port of shifts.ts). */
@RestController
@RequestMapping("/api/rpc")
@Tag(name = "Shifts and cash-up")
public class ShiftActions {
  private final Ctx ctx;
  private final Store store;
  private final SettingsService settingsService;
  private final Effects effects;
  private final Notifier notifier;
  private final AuditLog audit;

  public ShiftActions(Ctx ctx, Store store, SettingsService settingsService, Effects effects, Notifier notifier, AuditLog audit) {
    this.ctx = ctx;
    this.store = store;
    this.settingsService = settingsService;
    this.effects = effects;
    this.notifier = notifier;
    this.audit = audit;
  }

  private static List<Map<String, Object>> cleanChecklist(List<Map<String, Object>> answers, Object allowed) {
    List<Map<String, Object>> out = new ArrayList<>();
    if (!(allowed instanceof List<?> items)) return out;
    for (Object item : items) {
      boolean done = answers.stream().anyMatch(a -> item.equals(a.get("item")) && Boolean.TRUE.equals(a.get("done")));
      out.add(Map.of("item", item, "done", done));
    }
    return out;
  }

  @Operation(summary = "Open the day", description = "One till: only one shift may be open. The cash session shares the shift's id.")
  @PostMapping("/openShift")
  @Transactional
  public Map<String, Object> openShift(@AuthenticationPrincipal Jwt jwt, @RequestBody Map<String, Object> data) {
    Body d = Body.of(data);
    Caller c = ctx.require(jwt, d);
    long openingFloatCents = d.cents("openingFloatCents", "Opening float", 0, 1_000_000);
    String b = c.businessId();
    var open = store.listForUpdate(b, Query.of("shifts").where("status", "==", "open").limit(1).build());
    if (!open.isEmpty()) throw ApiException.precondition(open.get(0).get("employeeName") + "'s shift is still open – close it first");
    Settings settings = settingsService.read(b);
    String id = store.newId();
    String dayKey = Effects.todayKey(settings);

    Map<String, Object> shift = base(c, dayKey);
    shift.put("cashSessionId", id);
    shift.put("openingChecklist", cleanChecklist(d.objects("checklist"), settings.data().get("openingChecklist")));
    store.set(b, "shifts", id, shift);

    Map<String, Object> session = base(c, dayKey);
    session.put("shiftId", id);
    session.put("openingFloatCents", openingFloatCents);
    for (String k : List.of("cashSalesCents", "cashRefundsCents", "approvedCashExpensesCents", "pendingCashExpensesCents", "cashPayoutsCents", "cardSalesCents", "eftSalesCents")) {
      session.put(k, 0);
    }
    session.put("payouts", List.of());
    store.set(b, "cashSessions", id, session);
    audit.record(c, "shift.opened", "shifts", id, Map.of("openingFloatCents", openingFloatCents));
    return Map.of("shiftId", id);
  }

  private static Map<String, Object> base(Caller c, String dayKey) {
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("employeeId", c.uid());
    m.put("employeeName", c.name());
    m.put("status", "open");
    m.put("dayKey", dayKey);
    m.put("openedAt", Op.serverTime());
    return m;
  }

  @Operation(summary = "Cash taken out of the till", description = "For reasons other than an expense, e.g. a cash drop to the owner.")
  @PostMapping("/recordPayout")
  @Transactional
  public Map<String, Object> recordPayout(@AuthenticationPrincipal Jwt jwt, @RequestBody Map<String, Object> data) {
    Body d = Body.of(data);
    Caller c = ctx.require(jwt, d);
    long amount = d.cents("amountCents", "Amount", 1, 100_000_000);
    String reason = d.text("reason", "Reason", 3, 200);
    String b = c.businessId();
    Map<String, Object> shift = effects.findOpenShift(c).orElseThrow(() -> ApiException.precondition("No open shift"));
    Settings settings = settingsService.read(b);
    String sessionId = str(shift.get("cashSessionId"));
    Map<String, Object> session = store.getForUpdate(b, "cashSessions", sessionId).orElseThrow();
    List<Object> payouts = new ArrayList<>(Domain.list(session.get("payouts")));
    payouts.add(Map.of("amountCents", amount, "reason", reason, "by", c.uid(), "byName", c.name(), "at", System.currentTimeMillis()));
    store.update(b, "cashSessions", sessionId, Map.of("cashPayoutsCents", Op.inc(amount), "payouts", payouts));
    audit.record(c, "cash.payout", "cashSessions", sessionId, Map.of("amountCents", amount, "reason", reason));
    if ("employee".equals(c.role())) {
      notifier.notify(b, settings, Notifier.alert("cashPayout", "info", "Cash paid out: " + formatZar(amount))
          .message(c.name() + ": " + reason)
          .detail("Amount taken out", formatZar(amount), "bad")
          .detail("Reason given", reason)
          .detail("When", Days.localTime(Instant.now(), settings.timezone()))
          .detail("Shift", shift.get("employeeName") + ", opened " + local(shift.get("openedAt"), settings))
          .actor(c.name())
          .action("This amount is subtracted from the expected cash at cash-up. Make sure you received it.")
          .link("/cash"));
    }
    return Map.of("ok", true);
  }

  private static String local(Object ts, Settings s) {
    Long ms = Ts.millis(ts);
    return ms == null ? "" : Days.localTime(Instant.ofEpochMilli(ms), s.timezone());
  }

  @Operation(summary = "Cash up and close the shift", description = """
      Blind count: the cashier never sees the expected amount first. A difference needs an explanation. \
      Stock counts that differ become corrections for the owner to approve (applied straight away when the owner closes).""")
  @PostMapping("/closeShift")
  @Transactional
  public Map<String, Object> closeShift(@AuthenticationPrincipal Jwt jwt, @RequestBody Map<String, Object> data) {
    Body d = Body.of(data);
    Caller c = ctx.require(jwt, d);
    long counted = d.cents("countedCashCents", "Counted cash", 0, 10_000_000);
    Long cardTerminal = d.optCents("cardTerminalTotalCents", "Card machine total", 0, 10_000_000);
    String explanation = d.optText("explanation", "Explanation", 500);
    String notes = d.optText("notes", "Notes", 500);
    List<Map<String, Object>> counts = d.objects("stockCounts");
    if (counts.size() > 200) counts = counts.subList(0, 200);
    String b = c.businessId();

    String shiftId = d.str("shiftId");
    Map<String, Object> shift = store.getForUpdate(b, "shifts", shiftId).orElseThrow(() -> ApiException.notFound("Shift not found"));
    if (!"open".equals(shift.get("status"))) throw ApiException.precondition("This shift is already closed");
    if ("employee".equals(c.role()) && !c.uid().equals(shift.get("employeeId"))) throw ApiException.denied("This is not your shift");
    String sessionId = str(shift.get("cashSessionId"));
    Map<String, Object> session = store.getForUpdate(b, "cashSessions", sessionId).orElseThrow();
    Settings settings = settingsService.read(b);

    Set<String> countedIds = new HashSet<>();
    for (Map<String, Object> cnt : counts) {
      if (cnt.get("countedQty") instanceof Number n && !Double.isNaN(n.doubleValue())) countedIds.add(str(cnt.get("ingredientId")));
    }
    var mustCount = store.list(b, Query.of("ingredients").where("countDaily", "==", true).where("active", "==", true).build());
    List<String> missing = mustCount.stream().filter(i -> !countedIds.contains(str(i.get("id")))).map(i -> str(i.get("name"))).toList();
    if (!missing.isEmpty()) throw Domain.error("Count these items before closing: " + String.join(", ", missing));

    var cash = Domain.reconcileCash(session, counted, (long) settings.threshold("cashDiscrepancyCents"));
    if (cash.requiresExplanation() && (explanation == null || explanation.length() < 5)) throw Domain.error("Explain the cash difference before closing");
    long cardSales = cents(session.get("cardSalesCents"));
    Long cardDiff = cardTerminal == null ? null : cardTerminal - cardSales;

    List<Map<String, Object>> stockCounts = new ArrayList<>();
    Map<String, Map<String, Object>> countedIngredients = new LinkedHashMap<>();
    for (Map<String, Object> cnt : counts) {
      String ingId = str(cnt.get("ingredientId"));
      var ing = store.getForUpdate(b, "ingredients", ingId);
      if (ing.isEmpty()) continue;
      double q = cnt.get("countedQty") instanceof Number n ? n.doubleValue() : Double.NaN;
      stockCounts.add(Domain.stockCountLine(ing.get(), q));
      countedIngredients.put(ingId, ing.get());
    }

    // ---- writes ----
    Map<String, Object> shiftUpdate = new LinkedHashMap<>();
    shiftUpdate.put("status", "closed");
    shiftUpdate.put("closedAt", Op.serverTime());
    shiftUpdate.put("closingChecklist", cleanChecklist(d.objects("checklist"), settings.data().get("closingChecklist")));
    shiftUpdate.put("stockCounts", stockCounts);
    if (notes != null) shiftUpdate.put("notes", notes);
    store.update(b, "shifts", shiftId, shiftUpdate);

    Map<String, Object> sessionUpdate = new LinkedHashMap<>();
    sessionUpdate.put("status", "closed");
    sessionUpdate.put("closedAt", Op.serverTime());
    sessionUpdate.put("expectedCashCents", cash.expectedCashCents());
    sessionUpdate.put("countedCashCents", counted);
    sessionUpdate.put("differenceCents", cash.differenceCents());
    if (explanation != null) sessionUpdate.put("explanation", explanation);
    sessionUpdate.put("cardTerminalTotalCents", cardTerminal);
    sessionUpdate.put("cardDifferenceCents", cardDiff);
    store.update(b, "cashSessions", sessionId, sessionUpdate);

    long varianceValue = 0;
    long adjustedValue = 0;
    for (Map<String, Object> line : stockCounts) {
      double vq = Domain.num(line.get("varianceQty"));
      if (vq == 0) continue;
      varianceValue += Math.abs(cents(line.get("varianceCents")));
      String reason = "Closing count variance (" + Effects.qty(Domain.num(line.get("theoreticalQty"))) + " expected, " + Effects.qty(Domain.num(line.get("countedQty"))) + " counted)";
      String ingId = str(line.get("ingredientId"));
      if (c.isOwner()) {
        adjustedValue += (long) Math.signum(vq) * effects.applyStockChange(b, c, settings,
            new Effects.StockChange(countedIngredients.get(ingId), vq, "adjustment", reason, "ingredient", shiftId, shiftId, null, null), Map.of());
      } else {
        Map<String, Object> approval = new LinkedHashMap<>();
        approval.put("type", "stockAdjustment");
        approval.put("status", "pending");
        approval.put("refId", ingId);
        approval.put("summary", line.get("ingredientName") + ": " + (vq > 0 ? "+" : "") + Effects.qty(vq) + " " + line.get("unit") + " – " + reason);
        approval.put("amountCents", Math.abs(cents(line.get("varianceCents"))));
        approval.put("payload", Map.of("ingredientId", ingId, "qtyChange", vq, "reason", reason, "shiftId", shiftId));
        approval.put("requestedBy", c.uid());
        approval.put("requestedByName", c.name());
        approval.put("requestedAt", Op.serverTime());
        store.set(b, "approvals", store.newId(), approval);
      }
    }
    if (adjustedValue != 0) effects.bumpStats(b, str(shift.get("dayKey")), Map.of("stockAdjustmentCents", Op.inc(adjustedValue)));

    String opened = local(shift.get("openedAt"), settings);
    String closedAt = Days.localTime(Instant.now(), settings.timezone());
    long diff = cash.differenceCents();
    String diffTone = diff < 0 ? "bad" : diff > 0 ? "warn" : "good";
    List<Notifier.Detail> breakdown = new ArrayList<>(List.of(
        new Notifier.Detail("Shift", shift.get("employeeName") + " · " + opened + " → " + closedAt),
        new Notifier.Detail("Opening float", formatZar(cents(session.get("openingFloatCents")))),
        new Notifier.Detail("+ Cash sales", formatZar(cents(session.get("cashSalesCents")))),
        new Notifier.Detail("− Cash refunds", formatZar(cents(session.get("cashRefundsCents")))),
        new Notifier.Detail("− Approved cash expenses", formatZar(cents(session.get("approvedCashExpensesCents")))),
        new Notifier.Detail("− Cash paid out", formatZar(cents(session.get("cashPayoutsCents")))),
        new Notifier.Detail("= Expected in till", formatZar(cash.expectedCashCents())),
        new Notifier.Detail("Counted", formatZar(counted)),
        new Notifier.Detail("Difference", (diff > 0 ? "+" : "") + formatZar(diff), diffTone)));
    long pending = cents(session.get("pendingCashExpensesCents"));
    if (pending != 0) breakdown.add(new Notifier.Detail("Till expenses still awaiting approval", formatZar(pending), "warn"));
    if (explanation != null) breakdown.add(new Notifier.Detail("Explanation given", explanation));
    String diffText = diff == 0 ? "Cash balanced" : "Cash " + (diff < 0 ? "short" : "over") + " by " + formatZar(Math.abs(diff));

    List<Notifier.Detail> closedDetails = new ArrayList<>(breakdown);
    closedDetails.add(new Notifier.Detail("Card sales", formatZar(cardSales)));
    closedDetails.add(new Notifier.Detail("EFT sales", formatZar(cents(session.get("eftSalesCents")))));
    closedDetails.add(new Notifier.Detail("Stock items counted", stockCounts.size() + (varianceValue != 0 ? " · variance " + formatZar(varianceValue) : "")));
    if (notes != null) closedDetails.add(new Notifier.Detail("Notes from cashier", notes));
    notifier.notify(b, settings, Notifier.alert("shiftClosed", "info", "Shift closed by " + c.name())
        .message(diffText + ". Expected " + formatZar(cash.expectedCashCents()) + ", counted " + formatZar(counted) + ".")
        .details(closedDetails).actor(c.name()).link("/cash"));
    if (cash.isAlert()) {
      notifier.notify(b, settings, Notifier.alert("cashDiscrepancy", "critical", diffText)
          .message(c.name() + " closed with " + formatZar(counted) + " against " + formatZar(cash.expectedCashCents()) + " expected. Explanation: " + explanation)
          .details(breakdown).actor(c.name())
          .action("Check the explanation, any pending till expenses, and the till camera around " + closedAt + ". Compare with earlier cash-ups for a pattern.")
          .link("/cash"));
    }
    if (cardDiff != null && cardDiff != 0) {
      notifier.notify(b, settings, Notifier.alert("cashDiscrepancy", "warning", "Card machine differs by " + formatZar(Math.abs(cardDiff)))
          .message("Card machine total " + formatZar(cardTerminal) + " vs " + formatZar(cardSales) + " recorded card sales.")
          .detail("Shift", shift.get("employeeName") + " · " + opened + " → " + closedAt)
          .detail("Card machine batch total", formatZar(cardTerminal))
          .detail("Card sales recorded in the app", formatZar(cardSales))
          .detail("Difference", formatZar(cardDiff), cardDiff < 0 ? "bad" : "warn")
          .actor(c.name())
          .action(cardDiff > 0
              ? "More was swiped than recorded: a sale may have been taken on the machine but not rung up in the app."
              : "Less was swiped than recorded: a card sale may have been rung up but paid another way. Check the Sales list.")
          .link("/cash"));
    }
    List<Map<String, Object>> variances = stockCounts.stream().filter(l -> Domain.num(l.get("varianceQty")) != 0).toList();
    if (varianceValue > settings.threshold("stockVarianceAlertCents")) {
      var a = Notifier.alert("stockVariance", "warning", "Stock count variance " + formatZar(varianceValue))
          .message(variances.size() + " items did not match the expected stock at close.")
          .detail("Shift", shift.get("employeeName") + " · closed " + closedAt);
      variances.stream().sorted(Comparator.comparingLong(l -> -Math.abs(cents(l.get("varianceCents"))))).forEach(l -> {
        double vq = Domain.num(l.get("varianceQty"));
        a.detail(str(l.get("ingredientName")), "expected " + Effects.qty(Domain.num(l.get("theoreticalQty"))) + ", counted " + Effects.qty(Domain.num(l.get("countedQty")))
            + " " + l.get("unit") + " → " + (vq > 0 ? "+" : "") + Effects.qty(vq) + " (" + formatZar(cents(l.get("varianceCents"))) + ")", vq < 0 ? "bad" : "warn");
      });
      a.detail("Total variance at cost", formatZar(varianceValue), "bad").actor(c.name())
          .action("Approve or reject each correction in Approvals. Shortages of the same item day after day point to theft or unrecorded wastage.")
          .link("/approvals");
      notifier.notify(b, settings, a);
    }
    Map<String, Object> details = new LinkedHashMap<>();
    details.put("expectedCashCents", cash.expectedCashCents());
    details.put("countedCashCents", counted);
    details.put("differenceCents", diff);
    details.put("explanation", explanation);
    details.put("cardDifferenceCents", cardDiff);
    details.put("stockVarianceCents", varianceValue);
    audit.record(c, "shift.closed", "shifts", shiftId, details);

    Map<String, Object> result = new LinkedHashMap<>();
    result.put("expectedCashCents", cash.expectedCashCents());
    result.put("differenceCents", diff);
    result.put("cardDifferenceCents", cardDiff);
    result.put("stockVariances", variances);
    return result;
  }
}
