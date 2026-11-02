package za.co.kotahouse.staff;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import za.co.kotahouse.audit.AuditLog;
import za.co.kotahouse.auth.AuthService;
import za.co.kotahouse.auth.PasswordHasher;
import za.co.kotahouse.auth.TokenService;
import za.co.kotahouse.bridge.FirebaseBridge;
import za.co.kotahouse.common.AfterCommit;
import za.co.kotahouse.common.ApiException;
import za.co.kotahouse.common.Ids;
import za.co.kotahouse.common.Text;
import za.co.kotahouse.shop.Caller;
import za.co.kotahouse.shop.ShopAccess;

/**
 * Staff logins, owner only. Ported from createEmployee / updateEmployee in
 * functions/src/business.ts. Staff can never create logins or change roles.
 */
@Service
public class StaffService {
  private final JdbcClient db;
  private final PasswordHasher hasher;
  private final TokenService tokens;
  private final AuthService auth;
  private final ShopAccess access;
  private final AuditLog audit;
  private final FirebaseBridge bridge;
  private final za.co.kotahouse.store.ChangeFeed feed;

  public StaffService(JdbcClient db, PasswordHasher hasher, TokenService tokens, AuthService auth, ShopAccess access, AuditLog audit, FirebaseBridge bridge, za.co.kotahouse.store.ChangeFeed feed) {
    this.feed = feed;
    this.db = db;
    this.hasher = hasher;
    this.tokens = tokens;
    this.auth = auth;
    this.access = access;
    this.audit = audit;
    this.bridge = bridge;
  }

  /** Same shape as the Firestore employees/{uid} document the app reads today. */
  public record Employee(String uid, String displayName, String email, String phone, String role, boolean active, String createdBy, Instant createdAt) {}

  public List<Employee> list(Caller owner) {
    return db.sql("""
        select m.user_id, m.display_name, u.email, m.phone, m.role, m.active and not u.disabled, m.created_by, m.created_at
        from memberships m join users u on u.id = m.user_id
        where m.business_id = :b order by m.display_name""")
        .param("b", owner.businessId())
        .query((rs, i) -> new Employee(rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4), rs.getString(5), rs.getBoolean(6), rs.getString(7),
            rs.getTimestamp(8).toInstant()))
        .list();
  }

  public record NewEmployee(String email, String password, String displayName, String phone, String role) {}

  @Transactional
  public String create(Caller owner, NewEmployee d) {
    String displayName = Text.personName(d.displayName());
    String email = Text.email(d.email());
    String password = Text.newPassword(d.password());
    String role = "owner".equals(d.role()) ? "owner" : "kitchen".equals(d.role()) ? "kitchen" : "employee";
    String phone = Text.optional(d.phone(), "Phone", 20);
    boolean taken = db.sql("select exists (select 1 from users where email = :e)").param("e", email).query(Boolean.class).single();
    if (taken) throw ApiException.exists("This email already has a login – use another email");

    String uid = Ids.uid();
    db.sql("insert into users (id, email, display_name, password_algo, password_hash) values (:id, :e, :n, :a, :h)")
        .param("id", uid).param("e", email).param("n", displayName).param("a", PasswordHasher.ARGON2).param("h", hasher.hash(password)).update();
    db.sql("insert into memberships (business_id, user_id, role, display_name, phone, created_by) values (:b, :u, :r, :n, :p, :c)")
        .param("b", owner.businessId()).param("u", uid).param("r", role).param("n", displayName).param("p", phone).param("c", owner.uid()).update();
    feed.changed(owner.businessId(), "employees");
    audit.record(owner, "employee.created", "employees", uid, Map.of("displayName", displayName, "email", email, "role", role));
    AfterCommit.run(() -> bridge.syncMember(member(owner.businessId(), uid, password)));
    return uid;
  }

  public record Changes(Boolean active, String displayName, String phone, String password) {}

  @Transactional
  public void update(Caller owner, String uid, Changes d) {
    boolean exists = db.sql("select exists (select 1 from memberships where business_id = :b and user_id = :u)")
        .param("b", owner.businessId()).param("u", uid).query(Boolean.class).single();
    if (!exists) throw ApiException.notFound("Employee not found");
    if (uid.equals(owner.uid()) && Boolean.FALSE.equals(d.active())) throw ApiException.precondition("You cannot deactivate your own account");

    Map<String, Object> changes = new LinkedHashMap<>();
    if (d.active() != null) changes.put("active", d.active());
    if (d.displayName() != null) changes.put("displayName", Text.personName(d.displayName()));
    if (d.phone() != null) changes.put("phone", Text.optional(d.phone(), "Phone", 20));
    String password = d.password() == null ? null : Text.newPassword(d.password());

    if (changes.containsKey("active")) {
      db.sql("update memberships set active = :a where business_id = :b and user_id = :u")
          .param("a", d.active()).param("b", owner.businessId()).param("u", uid).update();
      // The login itself is switched off when the person has no other active shop.
      boolean otherShops = db.sql("select exists (select 1 from memberships where user_id = :u and active and business_id <> :b)")
          .param("u", uid).param("b", owner.businessId()).query(Boolean.class).single();
      if (!otherShops) db.sql("update users set disabled = :d where id = :u").param("d", !d.active()).param("u", uid).update();
    }
    if (changes.containsKey("displayName")) {
      db.sql("update memberships set display_name = :n where business_id = :b and user_id = :u")
          .param("n", changes.get("displayName")).param("b", owner.businessId()).param("u", uid).update();
      db.sql("update users set display_name = :n where id = :u").param("n", changes.get("displayName")).param("u", uid).update();
    }
    if (changes.containsKey("phone")) {
      db.sql("update memberships set phone = :p where business_id = :b and user_id = :u")
          .param("p", changes.get("phone")).param("b", owner.businessId()).param("u", uid).update();
    }
    if (password != null) auth.setPassword(uid, password);
    // Deactivated or new password: signed out everywhere straight away.
    if (Boolean.FALSE.equals(d.active()) || password != null) tokens.revokeAll(uid);

    Map<String, Object> details = new LinkedHashMap<>(changes);
    details.put("passwordReset", password != null);
    feed.changed(owner.businessId(), "employees");
    audit.record(owner, "employee.updated", "employees", uid, details);
    AfterCommit.run(() -> {
      bridge.syncMember(member(owner.businessId(), uid, null));
      if (password != null) bridge.passwordChanged(uid, password);
    });
  }

  private FirebaseBridge.Member member(String businessId, String uid, String password) {
    record Row(String email, String name, String phone, String role, boolean active, boolean disabled, String createdBy, String shop) {}
    Row r = db.sql("""
        select u.email, m.display_name, m.phone, m.role, m.active, u.disabled, m.created_by, b.name
        from memberships m join users u on u.id = m.user_id join businesses b on b.id = m.business_id
        where m.business_id = :b and m.user_id = :u""")
        .param("b", businessId).param("u", uid)
        .query((rs, i) -> new Row(rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4), rs.getBoolean(5), rs.getBoolean(6), rs.getString(7), rs.getString(8)))
        .single();
    var ms = access.memberships(uid);
    return new FirebaseBridge.Member(uid, r.email(), r.name(), r.phone(), businessId, r.shop(), r.role(), r.active(), r.disabled(), r.createdBy(),
        ShopAccess.roles(ms), ms.isEmpty() ? null : ms.get(0).businessId(), password);
  }
}
