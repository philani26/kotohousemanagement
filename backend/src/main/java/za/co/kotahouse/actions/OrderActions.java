package za.co.kotahouse.actions;

import static za.co.kotahouse.domain.Domain.str;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import za.co.kotahouse.common.ApiException;
import za.co.kotahouse.settings.SettingsService;
import za.co.kotahouse.shop.Caller;
import za.co.kotahouse.store.Op;
import za.co.kotahouse.store.Store;

/**
 * Kitchen tickets (the app used to write these straight to Firestore, with the
 * limits of the orders rules). The app queues these calls while offline and
 * sends them when the network is back; all of them are safe to repeat.
 */
@RestController
@RequestMapping("/api/rpc")
@Tag(name = "Order queue")
public class OrderActions {
  private static final Set<String> STATUSES = Set.of("new", "preparing", "ready", "collected");
  private static final Map<String, String> STAMP = Map.of("preparing", "preparingAt", "ready", "readyAt", "collected", "collectedAt");

  private final Ctx ctx;
  private final Store store;
  private final SettingsService settings;
  private final ApplicationEventPublisher events;

  public OrderActions(Ctx ctx, Store store, SettingsService settings, ApplicationEventPublisher events) {
    this.ctx = ctx;
    this.store = store;
    this.settings = settings;
    this.events = events;
  }

  /** Published after a ticket's status changed; the WhatsApp module tells the customer once it commits. */
  public record StatusChanged(String businessId, Map<String, Object> before, Map<String, Object> after) {}

  @Operation(summary = "Create the kitchen ticket for a sale", description = """
      orderId is the sale id, so a repeated call never makes a second ticket. Cashiers and the owner.""")
  @PostMapping("/createOrder")
  @Transactional
  public Map<String, Object> createOrder(@AuthenticationPrincipal Jwt jwt, @RequestBody Map<String, Object> data) {
    Body d = Body.of(data);
    Caller c = ctx.require(jwt, d);
    String b = c.businessId();
    String id = d.str("orderId");
    if (!id.matches("^[A-Za-z0-9_-]{16,64}$")) throw ApiException.invalid("Invalid order id");
    if (store.getForUpdate(b, "orders", id).isPresent()) return Map.of("ok", true, "duplicate", true);
    List<Map<String, Object>> lines = d.objects("lines");
    if (lines.isEmpty() || lines.size() > 30) throw ApiException.invalid("A ticket has 1 to 30 lines");
    List<Map<String, Object>> clean = lines.stream()
        .map(l -> Map.<String, Object>of("name", String.valueOf(l.get("name")), "quantity", l.get("quantity") instanceof Number n ? n.intValue() : 1))
        .toList();
    String note = d.optText("note", "Note", 200);
    Map<String, Object> order = new LinkedHashMap<>();
    order.put("receiptNo", d.optLong("receiptNo"));
    order.put("lines", clean);
    if (note != null) order.put("note", note);
    order.put("status", "new");
    Long created = d.optLong("createdAtMillis");
    long now = System.currentTimeMillis();
    // offline tickets keep their time, within the same 24 h as offline sales
    order.put("createdAtMillis", created != null && created <= now + 300_000 && created >= now - 86_400_000L ? created : now);
    order.put("createdBy", c.uid());
    order.put("createdByName", c.name());
    order.put("dayKey", Effects.todayKey(settings.read(b)));
    order.put("updatedBy", c.uid());
    order.put("updatedAt", Op.serverTime());
    store.set(b, "orders", id, order);
    return Map.of("ok", true, "duplicate", false);
  }

  @Operation(summary = "Move a ticket along the queue", description = """
      status: new, preparing, ready, collected. Kitchen staff can't hand over an unpaid WhatsApp order – it must be charged at the till first.""")
  @PostMapping("/setOrderStatus")
  @Transactional
  public Map<String, Object> setOrderStatus(@AuthenticationPrincipal Jwt jwt, @RequestBody Map<String, Object> data) {
    Body d = Body.of(data);
    Caller c = ctx.require(jwt, d, "owner", "employee", "kitchen");
    String b = c.businessId();
    String status = d.str("status");
    if (!STATUSES.contains(status)) throw ApiException.invalid("Invalid status");
    Map<String, Object> before = store.getForUpdate(b, "orders", d.str("orderId")).orElseThrow(() -> ApiException.notFound("Order not found"));
    if ("kitchen".equals(c.role()) && "collected".equals(status) && "whatsapp".equals(before.get("source")) && !Boolean.TRUE.equals(before.get("paid"))) {
      throw ApiException.denied("This WhatsApp order isn't paid yet – charge it at the till first");
    }
    Map<String, Object> changes = new LinkedHashMap<>();
    changes.put("status", status);
    String stamp = STAMP.get(status);
    if (stamp != null) changes.put(stamp, d.optLong("atMillis") != null ? d.optLong("atMillis") : System.currentTimeMillis());
    changes.put("updatedBy", c.uid());
    changes.put("updatedAt", Op.serverTime());
    String id = str(before.get("id"));
    store.update(b, "orders", id, changes);
    if (!status.equals(before.get("status"))) {
      Map<String, Object> after = new LinkedHashMap<>(before);
      after.putAll(changes);
      events.publishEvent(new StatusChanged(b, before, after));
    }
    return Map.of("ok", true);
  }

  @Operation(summary = "Link a ticket to its sale", description = """
      Adds the receipt number once an offline sale reached the server, and/or marks a WhatsApp order paid when charged at the till.""")
  @PostMapping("/linkOrderSale")
  @Transactional
  public Map<String, Object> linkOrderSale(@AuthenticationPrincipal Jwt jwt, @RequestBody Map<String, Object> data) {
    Body d = Body.of(data);
    Caller c = ctx.require(jwt, d);
    String b = c.businessId();
    String id = d.str("orderId");
    // sales of only extras have no ticket: nothing to link
    if (store.getForUpdate(b, "orders", id).isEmpty()) return Map.of("ok", true, "found", false);
    Map<String, Object> changes = new LinkedHashMap<>();
    if (d.optLong("receiptNo") != null) changes.put("receiptNo", d.optLong("receiptNo"));
    if (d.bool("paid")) changes.put("paid", true);
    if (d.has("saleId")) changes.put("saleId", d.str("saleId"));
    changes.put("updatedBy", c.uid());
    changes.put("updatedAt", Op.serverTime());
    store.update(b, "orders", id, changes);
    return Map.of("ok", true, "found", true);
  }
}
