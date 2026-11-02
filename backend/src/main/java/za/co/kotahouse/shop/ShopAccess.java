package za.co.kotahouse.shop;

import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.stereotype.Component;
import za.co.kotahouse.common.ApiException;

/**
 * Checks the caller's role in a shop on every request, from the database
 * (not from the token), so deactivating someone takes effect immediately.
 * Ported from requireCaller in functions/src/common.ts; the work-site and
 * approved-device checks move here with their modules (phase 4).
 */
@Component
public class ShopAccess {
  private final JdbcClient db;

  public ShopAccess(JdbcClient db) {
    this.db = db;
  }

  public Caller require(Jwt jwt, String businessId, String... roles) {
    if (jwt == null) throw ApiException.unauthenticated("Please sign in");
    String uid = jwt.getSubject();
    record Row(String role, String name, boolean active, boolean disabled) {}
    Row row = db.sql("""
        select m.role, m.display_name, m.active, u.disabled
        from memberships m join users u on u.id = m.user_id
        where m.business_id = :b and m.user_id = :u""")
        .param("b", businessId)
        .param("u", uid)
        .query((rs, i) -> new Row(rs.getString(1), rs.getString(2), rs.getBoolean(3), rs.getBoolean(4)))
        .optional()
        .orElseThrow(() -> ApiException.denied("Your account is not linked to this shop"));
    if (row.disabled() || !row.active()) throw ApiException.denied("Your account has been deactivated");
    List<String> allowed = roles.length == 0 ? List.of("owner", "employee") : Arrays.asList(roles);
    if (!allowed.contains(row.role())) throw ApiException.denied("You are not allowed to do this");
    return new Caller(uid, businessId, row.role(), row.name());
  }

  public record Membership(String businessId, String businessName, String role) {}

  /** Active shops of a person, oldest first (the first is their default shop). */
  public List<Membership> memberships(String uid) {
    return db.sql("""
        select m.business_id, b.name, m.role
        from memberships m join businesses b on b.id = m.business_id
        where m.user_id = :u and m.active
        order by m.created_at, m.business_id""")
        .param("u", uid)
        .query((rs, i) -> new Membership(rs.getString(1), rs.getString(2), rs.getString(3)))
        .list();
  }

  public static Map<String, String> roles(List<Membership> ms) {
    Map<String, String> out = new LinkedHashMap<>();
    ms.forEach(m -> out.put(m.businessId(), m.role()));
    return out;
  }
}
