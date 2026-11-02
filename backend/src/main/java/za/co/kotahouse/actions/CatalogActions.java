package za.co.kotahouse.actions;

import static za.co.kotahouse.domain.Domain.num;
import static za.co.kotahouse.domain.Domain.str;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
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
import za.co.kotahouse.settings.Settings;
import za.co.kotahouse.settings.SettingsService;
import za.co.kotahouse.shop.Caller;
import za.co.kotahouse.store.Op;
import za.co.kotahouse.store.Store;

/**
 * Menu, recipes, ingredients, suppliers and settings: the owner's edits, which
 * the app used to write straight to Firestore. Each record is checked like the
 * Firestore rules did, stamped, and logged like the auditCatalog triggers did;
 * a new ingredient's opening stock goes into the stock ledger.
 */
@RestController
@RequestMapping("/api/rpc")
@Tag(name = "Menu, stock items and settings")
public class CatalogActions {
  private static final Set<String> COLLECTIONS = Set.of("products", "recipes", "ingredients", "suppliers", "businessSettings");
  /** settings only the server sets (Yoco connection, receipt counter, stamps) */
  private static final Set<String> SERVER_SETTINGS = Set.of("yoco", "receiptCounter", "updatedAt", "updatedBy", "id");

  private final Ctx ctx;
  private final Store store;
  private final SettingsService settingsService;
  private final AuditLog audit;

  public CatalogActions(Ctx ctx, Store store, SettingsService settingsService, AuditLog audit) {
    this.ctx = ctx;
    this.store = store;
    this.settingsService = settingsService;
    this.audit = audit;
  }

  @Operation(summary = "Save menu, recipes, stock items, suppliers or settings", description = """
      Owner only. writes: [{collection, id?, data}] saved together (all or nothing). Without an id a new record is created \
      and its id returned. Settings (collection businessSettings) are merged into the shop's settings. \
      An ingredient's stock can only be set when it is created (opening stock); after that only stock actions move it.""")
  @PostMapping("/saveCatalog")
  @Transactional
  public Map<String, Object> saveCatalog(@AuthenticationPrincipal Jwt jwt, @RequestBody Map<String, Object> data) {
    Body d = Body.of(data);
    Caller owner = ctx.require(jwt, d, "owner");
    List<Map<String, Object>> writes = d.objects("writes");
    if (writes.isEmpty() || writes.size() > 100) throw ApiException.invalid("Send between 1 and 100 records");
    List<String> ids = new ArrayList<>();
    for (Map<String, Object> w : writes) {
      String collection = str(w.get("collection"));
      if (!COLLECTIONS.contains(collection)) throw ApiException.invalid("Can't save " + collection + " here");
      String id = w.get("id") == null || str(w.get("id")).isEmpty() ? store.newId() : str(w.get("id"));
      Map<String, Object> incoming = new LinkedHashMap<>(za.co.kotahouse.domain.Domain.map(w.get("data")));
      ids.add(save(owner, collection, "businessSettings".equals(collection) ? SettingsService.DOC : id, incoming));
    }
    return Map.of("ids", ids);
  }

  private String save(Caller owner, String collection, String id, Map<String, Object> incoming) {
    String b = owner.businessId();
    Map<String, Object> before = store.getForUpdate(b, collection, id).orElse(null);
    Map<String, Object> after = new LinkedHashMap<>(before == null ? Map.of() : before);
    if ("businessSettings".equals(collection)) {
      if (before == null) throw ApiException.notFound("Settings not found");
      incoming.forEach((k, v) -> {
        if (!SERVER_SETTINGS.contains(k)) after.put(k, v);
      });
      validateSettings(after);
    } else {
      after.putAll(incoming);
      validate(collection, id, before, after);
    }
    after.put("updatedBy", owner.uid());
    after.put("updatedAt", Op.serverTime());
    store.set(b, collection, id, after);

    // audit, like the auditCatalog triggers
    Set<String> keys = new LinkedHashSet<>(before == null ? Set.of() : before.keySet());
    keys.addAll(after.keySet());
    List<String> fields = keys.stream()
        .filter(k -> !k.equals("updatedAt") && !k.equals("updatedBy") && !k.equals("id"))
        .filter(k -> !Objects.equals(before == null ? null : before.get(k), after.get(k)))
        .toList();
    if (!fields.isEmpty()) {
      Map<String, Object> was = new LinkedHashMap<>();
      Map<String, Object> now = new LinkedHashMap<>();
      for (String f : fields) {
        if (before != null && before.containsKey(f)) was.put(f, before.get(f));
        if (after.containsKey(f)) now.put(f, after.get(f));
      }
      audit.record(owner, collection + "." + (before == null ? "created" : "updated"), collection, id, Map.of("fields", fields, "before", was, "after", now));
    }

    // Opening stock is recorded in the stock ledger when an ingredient is created.
    if ("ingredients".equals(collection) && before == null && num(after.get("openingQty")) > 0) {
      Settings settings = settingsService.read(b);
      double qty = num(after.get("openingQty"));
      long cost = Math.round(num(after.get("unitCostCents")));
      Map<String, Object> mv = new LinkedHashMap<>();
      mv.put("ingredientId", id);
      mv.put("ingredientName", after.get("name"));
      mv.put("type", "opening");
      mv.put("qtyChange", qty);
      mv.put("unitCostCents", cost);
      mv.put("valueCents", Math.round(qty * cost));
      mv.put("reason", "Opening stock");
      mv.put("refType", "ingredient");
      mv.put("refId", id);
      mv.put("shiftId", null);
      mv.put("createdBy", owner.uid());
      mv.put("createdByName", owner.name());
      mv.put("createdAt", Op.serverTime());
      mv.put("dayKey", Effects.todayKey(settings));
      store.set(b, "stockMovements", store.newId(), mv);
    }
    return id;
  }

  private static void validate(String collection, String id, Map<String, Object> before, Map<String, Object> d) {
    switch (collection) {
      case "products" -> {
        nonEmpty(d.get("name"), 60, "Name");
        money(d.get("priceCents"), "Price");
        bool(d.get("active"), "Active");
        nonEmpty(d.get("category"), 40, "Category");
      }
      case "recipes" -> {
        d.put("productId", id);
        if (!(d.get("lines") instanceof List<?> lines) || lines.size() > 30) throw ApiException.invalid("A recipe has up to 30 lines");
        for (Object l : lines) {
          if (!(l instanceof Map<?, ?> m) || !(m.get("ingredientId") instanceof String) || !(m.get("quantity") instanceof Number q) || q.doubleValue() < 0) {
            throw ApiException.invalid("Each recipe line needs an ingredient and a quantity");
          }
        }
      }
      case "ingredients" -> {
        nonEmpty(d.get("name"), 60, "Name");
        money(d.get("unitCostCents"), "Unit cost");
        qty(d.get("reorderLevel"), "Reorder level");
        if (before == null) {
          // opening balance is set once; afterwards only stock actions move it
          qty(d.get("openingQty"), "Opening stock");
          d.put("currentQty", d.get("openingQty"));
        } else {
          d.put("currentQty", before.get("currentQty"));
          d.put("openingQty", before.get("openingQty"));
        }
      }
      case "suppliers" -> nonEmpty(d.get("name"), 80, "Name");
      default -> throw ApiException.invalid("Can't save " + collection);
    }
  }

  private static void validateSettings(Map<String, Object> s) {
    if (!"ZAR".equals(s.get("currency"))) throw ApiException.invalid("Currency must be ZAR");
    if (!(s.get("maxEmployeeDiscountPercent") instanceof Number n) || n.doubleValue() < 0 || n.doubleValue() > 100) {
      throw ApiException.invalid("Cashier discount limit must be 0–100%");
    }
    if (!(s.get("expenseCategories") instanceof List<?>)) throw ApiException.invalid("Expense categories must be a list");
    if (s.get("productCategories") != null && (!(s.get("productCategories") instanceof List<?> pc) || pc.size() > 40)) {
      throw ApiException.invalid("Up to 40 menu categories");
    }
    if (!(s.get("thresholds") instanceof Map<?, ?>)) throw ApiException.invalid("Alert thresholds are missing");
  }

  private static void nonEmpty(Object v, int max, String label) {
    if (!(v instanceof String s) || s.isEmpty() || s.length() > max) throw ApiException.invalid(label + " is required (up to " + max + " characters)");
  }

  private static void money(Object v, String label) {
    if (!(v instanceof Number n) || n.doubleValue() != Math.rint(n.doubleValue()) || n.longValue() < 0 || n.longValue() > 100_000_000) {
      throw ApiException.invalid(label + " must be a whole number of cents");
    }
  }

  private static void qty(Object v, String label) {
    if (!(v instanceof Number n) || n.doubleValue() < 0 || n.doubleValue() > 1_000_000) throw ApiException.invalid(label + " must be a number from 0");
  }

  private static void bool(Object v, String label) {
    if (!(v instanceof Boolean)) throw ApiException.invalid(label + " must be true or false");
  }

  @Operation(summary = "Mark alerts as read", description = "Owner only. ids: the notifications to mark; all: true marks every unread one.")
  @PostMapping("/markNotificationsRead")
  @Transactional
  public Map<String, Object> markNotificationsRead(@AuthenticationPrincipal Jwt jwt, @RequestBody Map<String, Object> data) {
    Body d = Body.of(data);
    Caller owner = ctx.require(jwt, d, "owner");
    String b = owner.businessId();
    List<String> ids = new ArrayList<>();
    if (d.bool("all")) {
      store.list(b, za.co.kotahouse.store.Query.of("notifications").where("read", "==", false).limit(500).build()).forEach(n -> ids.add(str(n.get("id"))));
    } else {
      d.list("ids").forEach(i -> ids.add(String.valueOf(i)));
    }
    if (ids.size() > 500) throw ApiException.invalid("Too many at once");
    for (String id : ids) {
      if (store.get(b, "notifications", id).isPresent()) store.update(b, "notifications", id, Map.of("read", true));
    }
    return Map.of("count", ids.size());
  }
}
