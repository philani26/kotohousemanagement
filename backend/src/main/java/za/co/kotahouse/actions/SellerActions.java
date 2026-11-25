package za.co.kotahouse.actions;

import static za.co.kotahouse.domain.Domain.cents;
import static za.co.kotahouse.domain.Domain.formatZar;
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

/**
 * Stock handed to a mobile ("outside") seller and reconciled on return.
 *
 * <p>Issuing a run prices the kotas from the menu and takes their ingredients
 * out of stock, exactly as a sale would. Settling it counts what came back
 * (stock goes back in), works out what was sold and the cash due, and records
 * any shortfall against the cash the seller handed in. The run is its own
 * ledger – it does not touch the till's cash session or the day's sales totals.
 */
@RestController
@RequestMapping("/api/rpc")
@Tag(name = "Sellers")
public class SellerActions {
  private final Ctx ctx;
  private final Store store;
  private final SettingsService settingsService;
  private final Effects effects;
  private final Notifier notifier;
  private final AuditLog audit;

  public SellerActions(Ctx ctx, Store store, SettingsService settingsService, Effects effects, Notifier notifier, AuditLog audit) {
    this.ctx = ctx;
    this.store = store;
    this.settingsService = settingsService;
    this.effects = effects;
    this.notifier = notifier;
    this.audit = audit;
  }

  private static int wholeQty(Object q, String what) {
    double n = q instanceof Number num ? num.doubleValue() : Double.NaN;
    if (!Double.isFinite(n) || n != Math.rint(n) || n < 1 || n > 100_000) throw Domain.error("Enter a whole number of " + what);
    return (int) n;
  }

  @Operation(summary = "Hand stock to a mobile seller", description = """
      Records the kotas a seller takes out to sell and prices them from the menu. \
      Their ingredients come out of stock straight away, just like a sale. Settle the run when the seller returns.""")
  @PostMapping("/issueSellerRun")
  @Transactional
  public Map<String, Object> issueSellerRun(@AuthenticationPrincipal Jwt jwt, @RequestBody Map<String, Object> data) {
    Body d = Body.of(data);
    Caller c = ctx.require(jwt, d);
    String b = c.businessId();
    String sellerName = d.text("sellerName", "Seller name", 2, 60);
    String sellerPhone = null;
    if (d.has("sellerPhone") && !d.str("sellerPhone").isEmpty()) {
      sellerPhone = Domain.waPhone(d.str("sellerPhone"));
      if (sellerPhone == null) throw Domain.error("Enter a valid cellphone number, e.g. 082 123 4567");
    }

    List<Map<String, Object>> rawLines = d.objects("lines");
    if (rawLines.isEmpty() || rawLines.size() > 50) throw Domain.error("Add between 1 and 50 items");
    List<Domain.CartItem> items = new ArrayList<>();
    Set<String> productIds = new LinkedHashSet<>();
    for (Map<String, Object> l : rawLines) {
      String pid = str(l.get("productId"));
      items.add(new Domain.CartItem(pid, wholeQty(l.get("quantity"), "kotas")));
      productIds.add(pid);
    }
    if (productIds.size() != rawLines.size()) throw Domain.error("Each item may appear once");

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
    var shift = effects.findOpenShift(c);
    String shiftId = shift.map(s -> str(s.get("id"))).orElse(null);

    Domain.Priced priced = Domain.priceCart(items, products, 0);
    Domain.UsageResult usage = Domain.ingredientUsage(priced.lines(), recipes, ingredients);

    String runId = store.newId();
    for (Domain.Usage u : usage.usage()) {
      Map<String, Object> ing = ingredients.get(u.ingredientId());
      if (ing == null) continue;
      effects.applyStockChange(b, c, settings,
          new Effects.StockChange(ing, -u.quantity(), "sellerOut", null, "seller", runId, shiftId, "Seller run – " + sellerName, null), Map.of());
    }

    Map<String, Object> run = new LinkedHashMap<>();
    run.put("sellerName", sellerName);
    if (sellerPhone != null) run.put("sellerPhone", sellerPhone);
    run.put("status", "out");
    run.put("lines", priced.lines());
    run.put("takenValueCents", priced.totalCents());
    run.put("takenCostCents", usage.costCents());
    run.put("shiftId", shiftId);
    run.put("issuedBy", c.uid());
    run.put("issuedByName", c.name());
    run.put("issuedAt", Op.serverTime());
    run.put("dayKey", Effects.todayKey(settings));
    store.set(b, "sellerRuns", runId, run);

    audit.record(c, "seller.issued", "sellerRuns", runId,
        Map.of("seller", sellerName, "valueCents", priced.totalCents(), "items", priced.lines().size()));
    return Map.of("runId", runId);
  }

  @Operation(summary = "Settle a seller's run", description = """
      Count what the seller brought back. Sold = taken − returned; the returned kotas' ingredients go back into stock. \
      The app works out the cash due and flags any shortfall against the cash handed in.""")
  @PostMapping("/settleSellerRun")
  @Transactional
  public Map<String, Object> settleSellerRun(@AuthenticationPrincipal Jwt jwt, @RequestBody Map<String, Object> data) {
    Body d = Body.of(data);
    Caller c = ctx.require(jwt, d);
    String b = c.businessId();
    String runId = d.str("runId");
    Map<String, Object> run = store.getForUpdate(b, "sellerRuns", runId).orElseThrow(() -> ApiException.notFound("Run not found"));
    if (!"out".equals(run.get("status"))) throw ApiException.precondition("This run has already been settled");
    long cashReceived = d.cents("cashReceivedCents", "Cash handed in", 0, 100_000_000);
    Settings settings = settingsService.read(b);

    Map<String, Double> returned = new LinkedHashMap<>();
    for (Map<String, Object> r : d.objects("returns")) {
      double q = r.get("returnedQty") instanceof Number n ? n.doubleValue() : Double.NaN;
      if (!Double.isFinite(q) || q < 0 || q != Math.rint(q)) throw Domain.error("Returned amounts must be whole numbers, 0 or more");
      returned.merge(str(r.get("productId")), q, Double::sum);
    }

    List<Map<String, Object>> updatedLines = new ArrayList<>();
    List<Map<String, Object>> returnLines = new ArrayList<>();
    Set<String> returnedProductIds = new LinkedHashSet<>();
    long soldValue = 0;
    for (Map<String, Object> line : Domain.list(run.get("lines"))) {
      String pid = str(line.get("productId"));
      double takenQty = num(line.get("quantity"));
      double ret = returned.getOrDefault(pid, 0.0);
      if (ret > takenQty) throw Domain.error("Returned more " + line.get("name") + " than went out (" + Effects.qty(takenQty) + ")");
      double sold = Domain.roundQty(takenQty - ret);
      long unitPrice = cents(line.get("unitPriceCents"));
      Map<String, Object> ul = new LinkedHashMap<>(line);
      ul.put("returnedQty", Domain.roundQty(ret));
      ul.put("soldQty", sold);
      updatedLines.add(ul);
      soldValue += Math.round(sold * unitPrice);
      if (ret > 0) {
        Map<String, Object> rl = new LinkedHashMap<>();
        rl.put("productId", pid);
        rl.put("quantity", ret);
        returnLines.add(rl);
        returnedProductIds.add(pid);
      }
    }

    // Returned kotas go back into stock (their ingredients are added back).
    if (!returnLines.isEmpty()) {
      Map<String, Map<String, Object>> recipes = new LinkedHashMap<>();
      for (String id : returnedProductIds) store.get(b, "recipes", id).ifPresent(r -> recipes.put(id, r));
      Set<String> ingredientIds = new LinkedHashSet<>();
      recipes.values().forEach(r -> Domain.list(r.get("lines")).forEach(l -> ingredientIds.add(str(l.get("ingredientId")))));
      Map<String, Map<String, Object>> ingredients = effects.getAllForUpdate(b, "ingredients", List.copyOf(ingredientIds));
      Domain.UsageResult back = Domain.ingredientUsage(returnLines, recipes, ingredients);
      for (Domain.Usage u : back.usage()) {
        Map<String, Object> ing = ingredients.get(u.ingredientId());
        if (ing == null) continue;
        effects.applyStockChange(b, c, settings,
            new Effects.StockChange(ing, u.quantity(), "sellerReturn", null, "seller", runId, str(run.get("shiftId")), "Seller return – " + run.get("sellerName"), null), Map.of());
      }
    }

    long shortfall = soldValue - cashReceived;
    Map<String, Object> changes = new LinkedHashMap<>();
    changes.put("status", "settled");
    changes.put("lines", updatedLines);
    changes.put("soldValueCents", soldValue);
    changes.put("cashReceivedCents", cashReceived);
    changes.put("shortfallCents", shortfall);
    changes.put("settledBy", c.uid());
    changes.put("settledByName", c.name());
    changes.put("settledAt", Op.serverTime());
    store.update(b, "sellerRuns", runId, changes);

    // A seller who brings back less cash than the kotas they sold is worth the owner's attention.
    long limit = (long) settings.threshold("sellerShortfallCents");
    if (limit <= 0) limit = 2000; // settings saved before this field existed
    if (shortfall >= limit) {
      notifier.notify(b, settings, Notifier.alert("sellerShortfall", shortfall >= limit * 2 ? "critical" : "warning",
          "Seller short: " + formatZar(shortfall))
          .message(run.get("sellerName") + " sold " + formatZar(soldValue) + " of kotas but handed in " + formatZar(cashReceived) + ".")
          .detail("Seller", str(run.get("sellerName")))
          .detail("Kotas sold (value)", formatZar(soldValue))
          .detail("Cash handed in", formatZar(cashReceived))
          .detail("Short by", formatZar(shortfall), "bad")
          .detail("Settled by", c.name() + " at " + Days.localTime(Instant.now(), settings.timezone()))
          .actor(c.name())
          .action("Check the count and the cash. The returned kotas have been put back into stock.")
          .link("/sellers"));
    }

    audit.record(c, "seller.settled", "sellerRuns", runId,
        Map.of("seller", str(run.get("sellerName")), "soldValueCents", soldValue, "cashReceivedCents", cashReceived, "shortfallCents", shortfall));
    return Map.of("soldValueCents", soldValue, "cashReceivedCents", cashReceived, "shortfallCents", shortfall);
  }
}
