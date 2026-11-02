package za.co.kotahouse.audit;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.stereotype.Component;
import za.co.kotahouse.common.Days;
import za.co.kotahouse.shop.Caller;
import za.co.kotahouse.store.Op;
import za.co.kotahouse.store.Store;

/**
 * Append-only activity log (shop records "auditLogs", the shape the Activity
 * log screen reads). Call it inside the same transaction as the change it
 * describes, so a change is never saved without its log entry or vice versa.
 */
@Component
public class AuditLog {
  public static final String COLLECTION = "auditLogs";

  private final Store store;

  public AuditLog(Store store) {
    this.store = store;
  }

  public void record(Caller actor, String action, String entity, String entityId, Map<String, ?> details) {
    write(actor.businessId(), actor.uid(), actor.name(), actor.role(), action, entity, entityId, details);
  }

  /** Entries made by the system itself (scheduled checks, webhooks). */
  public void system(String businessId, String action, String entity, String entityId, Map<String, ?> details) {
    write(businessId, "system", "System", "system", action, entity, entityId, details);
  }

  private void write(String b, String uid, String name, String role, String action, String entity, String entityId, Map<String, ?> details) {
    Map<String, Object> clean = new LinkedHashMap<>();
    details.forEach((k, v) -> {
      if (v != null) clean.put(k, v);
    });
    Map<String, Object> entry = new LinkedHashMap<>();
    entry.put("action", action);
    entry.put("entity", entity);
    entry.put("entityId", entityId);
    entry.put("actorUid", uid);
    entry.put("actorName", name);
    entry.put("actorRole", role);
    entry.put("details", clean);
    entry.put("at", Op.serverTime());
    entry.put("dayKey", Days.dayKey(Instant.now(), "Africa/Johannesburg"));
    store.set(b, COLLECTION, store.newId(), entry);
  }
}
