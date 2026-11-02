package za.co.kotahouse.audit;

import java.util.Map;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;
import za.co.kotahouse.shop.Caller;

/** Append-only activity log; call it inside the same transaction as the change it describes. */
@Component
public class AuditLog {
  private final JdbcClient db;
  private final JsonMapper json;

  public AuditLog(JdbcClient db, JsonMapper json) {
    this.db = db;
    this.json = json;
  }

  public void record(Caller actor, String action, String refType, String refId, Map<String, ?> details) {
    db.sql("""
        insert into audit_log (business_id, actor_uid, actor_name, actor_role, action, ref_type, ref_id, details)
        values (:b, :uid, :name, :role, :action, :refType, :refId, cast(:details as jsonb))""")
        .param("b", actor.businessId())
        .param("uid", actor.uid())
        .param("name", actor.name())
        .param("role", actor.role())
        .param("action", action)
        .param("refType", refType)
        .param("refId", refId)
        .param("details", json.writeValueAsString(details))
        .update();
  }
}
