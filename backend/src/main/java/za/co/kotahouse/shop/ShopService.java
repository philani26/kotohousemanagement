package za.co.kotahouse.shop;

import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import za.co.kotahouse.audit.AuditLog;
import za.co.kotahouse.bridge.FirebaseBridge;
import za.co.kotahouse.common.AfterCommit;
import za.co.kotahouse.common.ApiException;
import za.co.kotahouse.common.Ids;
import za.co.kotahouse.common.Text;
import za.co.kotahouse.config.AppProperties;

/** Shops (tenants). Ported from setupBusiness in functions/src/business.ts. */
@Service
public class ShopService {
  static final int MAX_SHOPS_PER_OWNER = 20;

  private final JdbcClient db;
  private final ShopAccess access;
  private final AuditLog audit;
  private final FirebaseBridge bridge;
  private final AppProperties props;

  public ShopService(JdbcClient db, ShopAccess access, AuditLog audit, FirebaseBridge bridge, AppProperties props) {
    this.db = db;
    this.access = access;
    this.audit = audit;
    this.bridge = bridge;
    this.props = props;
  }

  /**
   * Creates a shop and makes the caller its owner: the very first shop after
   * signing up, or another kota house. Each shop is a separate tenant.
   */
  @Transactional
  public String create(String uid, String businessNameIn, String displayNameIn) {
    var user = db.sql("select email, disabled from users where id = :u").param("u", uid)
        .query((rs, i) -> Map.entry(rs.getString(1), rs.getBoolean(2))).optional()
        .orElseThrow(() -> ApiException.unauthenticated("Please sign in"));
    if (user.getValue()) throw ApiException.denied("Your account has been deactivated");
    List<ShopAccess.Membership> existing = access.memberships(uid);
    if (!existing.isEmpty() && existing.stream().noneMatch(m -> "owner".equals(m.role()))) {
      throw ApiException.denied("Only a shop owner can add another shop");
    }
    if (existing.size() >= MAX_SHOPS_PER_OWNER) throw ApiException.precondition("You can have up to " + MAX_SHOPS_PER_OWNER + " shops");
    List<String> allowed = props.ownerEmailList();
    if (!allowed.isEmpty() && !allowed.contains(user.getKey())) throw ApiException.denied("This email is not allowed to create a business");

    String businessName = Text.require(businessNameIn, "Business name", 2, 80);
    String displayName = Text.personName(displayNameIn);
    String businessId = Ids.doc();
    db.sql("insert into businesses (id, name, owner_uid) values (:id, :n, :o)").param("id", businessId).param("n", businessName).param("o", uid).update();
    db.sql("insert into memberships (business_id, user_id, role, display_name, created_by) values (:b, :u, 'owner', :n, :u)")
        .param("b", businessId).param("u", uid).param("n", displayName).update();
    Caller owner = new Caller(uid, businessId, "owner", displayName);
    audit.record(owner, "business.created", "businesses", businessId, Map.of("businessName", businessName, "additionalShop", !existing.isEmpty()));

    // Mirror to Firebase only once PostgreSQL has committed.
    AfterCommit.run(() -> {
      bridge.shopCreated(businessId, businessName, uid);
      var ms = access.memberships(uid);
      bridge.syncMember(new FirebaseBridge.Member(uid, user.getKey(), displayName, null, businessId, businessName, "owner", true, false, uid,
          ShopAccess.roles(ms), ms.get(0).businessId(), null));
    });
    return businessId;
  }
}
