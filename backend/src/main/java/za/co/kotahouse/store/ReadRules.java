package za.co.kotahouse.store;

import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import za.co.kotahouse.common.ApiException;
import za.co.kotahouse.shop.Caller;

/**
 * Who may read which records: a port of the read rules in firestore.rules.
 * For lists, a person's limits become part of the SQL, so records they may not
 * see are never loaded. Anything not listed here can't be read from the app.
 */
public final class ReadRules {
  private ReadRules() {}

  private static final Set<String> STAFF = Set.of("owner", "employee");
  private static final Set<String> ANYONE = Set.of("owner", "employee", "kitchen");

  /** A rule: the SQL limit on lists (null = everything, throws = no access) and the check for one record. */
  interface Rule {
    Store.Condition list(Caller c);

    boolean get(Caller c, Map<String, Object> doc);
  }

  private static Rule roles(Set<String> roles) {
    return new Rule() {
      public Store.Condition list(Caller c) {
        if (!roles.contains(c.role())) throw denied();
        return null;
      }

      public boolean get(Caller c, Map<String, Object> doc) {
        return roles.contains(c.role());
      }
    };
  }

  /** Owner: all. Others in {@code roles}: only records whose {@code field} is their uid. */
  private static Rule ownerOrOwn(Set<String> roles, String field) {
    return new Rule() {
      public Store.Condition list(Caller c) {
        if (c.isOwner()) return null;
        if (!roles.contains(c.role())) throw denied();
        return new Store.Condition("data ->> '" + field + "' = :ruid", Map.of("ruid", c.uid()));
      }

      public boolean get(Caller c, Map<String, Object> doc) {
        return c.isOwner() || (roles.contains(c.role()) && c.uid().equals(doc.get(field)));
      }
    };
  }

  /** Staff may open one record by id (e.g. look up a customer number), only the owner may list them all. */
  private static Rule getStaffListOwner() {
    return new Rule() {
      public Store.Condition list(Caller c) {
        if (!c.isOwner()) throw denied();
        return null;
      }

      public boolean get(Caller c, Map<String, Object> doc) {
        return STAFF.contains(c.role());
      }
    };
  }

  private static final Map<String, Rule> RULES = new HashMap<>();

  static {
    Rule ownerOnly = roles(Set.of("owner"));
    RULES.put("businessSettings", roles(ANYONE));
    RULES.put("orders", roles(ANYONE));
    for (String c : new String[] {"products", "recipes", "ingredients", "suppliers"}) RULES.put(c, roles(STAFF));
    for (String c : new String[] {"cashSessions", "whatsappMessages", "whatsappChats", "devices", "activity", "deviceInvites", "auditLogs", "dailyStats", "notifications", "cardTransactions"}) {
      RULES.put(c, ownerOnly);
    }
    RULES.put("employees", ownerOrOwn(ANYONE, "uid"));
    RULES.put("sales", ownerOrOwn(STAFF, "employeeId"));
    RULES.put("expenses", ownerOrOwn(STAFF, "submittedBy"));
    RULES.put("approvals", ownerOrOwn(STAFF, "requestedBy"));
    RULES.put("stockMovements", ownerOrOwn(STAFF, "createdBy"));
    RULES.put("purchases", ownerOrOwn(STAFF, "createdBy"));
    RULES.put("timeEntries", ownerOrOwn(ANYONE, "uid"));
    RULES.put("customers", getStaffListOwner());
    RULES.put("yocoCheckouts", getStaffListOwner());
    // Staff see whether a shift is open (single till) and their own shifts.
    RULES.put("shifts", new Rule() {
      public Store.Condition list(Caller c) {
        if (c.isOwner()) return null;
        if (!STAFF.contains(c.role())) throw denied();
        return new Store.Condition("data ->> 'employeeId' = :ruid or data ->> 'status' = 'open'", Map.of("ruid", c.uid()));
      }

      public boolean get(Caller c, Map<String, Object> doc) {
        return c.isOwner() || (STAFF.contains(c.role()) && (c.uid().equals(doc.get("employeeId")) || "open".equals(doc.get("status"))));
      }
    });
  }

  private static Rule rule(String collection) {
    Rule r = RULES.get(collection);
    if (r == null) throw denied();
    return r;
  }

  /** The SQL limit for listing (null = no limit); throws if the person may not list this collection. */
  public static Store.Condition listCondition(Caller c, String collection) {
    return rule(collection).list(c);
  }

  /** Whether the person can open at least some records of this collection (used when a record doesn't exist). */
  public static boolean mayOpen(Caller c, String collection) {
    Rule r = rule(collection);
    try {
      r.list(c);
      return true;
    } catch (ApiException e) {
      return r.get(c, Map.of());
    }
  }

  public static boolean canGet(Caller c, String collection, Map<String, Object> doc) {
    return rule(collection).get(c, doc);
  }

  private static ApiException denied() {
    return ApiException.denied("You do not have access to this information");
  }
}
