package za.co.kotahouse.store;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;
import za.co.kotahouse.common.ApiException;
import za.co.kotahouse.common.Ids;

/**
 * Shop records in PostgreSQL. Call it inside a @Transactional service method:
 * reads with {@code forUpdate} lock the rows until commit, so read-then-write
 * logic ported from Firestore transactions keeps its guarantees.
 *
 * "employees" is not stored here: it is served from the memberships table
 * (the source of truth for staff), and only its profile extras can be updated.
 */
@Component
public class Store {
  private static final Pattern FIELD = Pattern.compile("^[A-Za-z0-9_]+(\\.[A-Za-z0-9_]+)*$");
  private static final Pattern NAME = Pattern.compile("^[A-Za-z0-9_-]{1,128}$");
  private static final TypeReference<Map<String, Object>> MAP = new TypeReference<>() {};
  public static final String EMPLOYEES = "employees";
  /** employee fields owned by the memberships table; never written through the store */
  private static final Set<String> EMPLOYEE_CORE = Set.of("uid", "displayName", "email", "phone", "role", "active", "createdBy", "createdAt");

  private final JdbcClient db;
  private final JsonMapper json;
  private final ChangeFeed feed;

  public Store(JdbcClient db, JsonMapper json, ChangeFeed feed) {
    this.db = db;
    this.json = json;
    this.feed = feed;
  }

  public String newId() {
    return Ids.doc();
  }

  // ---------------------------------------------------------------- reads

  public Optional<Map<String, Object>> get(String b, String c, String id) {
    return get(b, c, id, false);
  }

  public Optional<Map<String, Object>> getForUpdate(String b, String c, String id) {
    return get(b, c, id, true);
  }

  private Optional<Map<String, Object>> get(String b, String c, String id, boolean lock) {
    check(c, id);
    if (EMPLOYEES.equals(c) && lock) {
      // the staff record lives in memberships: lock that row
      db.sql("select 1 from memberships where business_id = :b and user_id = :id for update").param("b", b).param("id", id).query(Integer.class).optional();
    }
    String sql = "select data from (" + source(c) + ") s where id = :id" + (lock && !EMPLOYEES.equals(c) ? " for update" : "");
    return db.sql(sql).param("b", b).param("c", c).param("id", id).query(String.class).optional().map(this::read);
  }

  public List<Map<String, Object>> list(String b, Query query) {
    return list(b, query, false, null);
  }

  public List<Map<String, Object>> listForUpdate(String b, Query query) {
    return list(b, query, true, null);
  }

  /**
   * @param extraWhere an SQL condition on "data" added by the caller (read permissions), with its own params
   */
  public List<Map<String, Object>> list(String b, Query query, boolean lock, Condition extraWhere) {
    String c = query.collection();
    check(c, null);
    StringBuilder sql = new StringBuilder("select data from (").append(source(c)).append(") s where true");
    Map<String, Object> params = new LinkedHashMap<>();
    params.put("b", b);
    params.put("c", c);
    int i = 0;
    for (Query.Filter f : query.filters()) {
      String path = path(f.field());
      if (f.op() == Query.Operator.IN) {
        List<?> values = f.value() instanceof List<?> l ? l : List.of(f.value());
        if (values.isEmpty()) return List.of();
        List<String> ph = new ArrayList<>();
        for (Object v : values) {
          String p = "v" + i++;
          params.put(p, write(v));
          ph.add("cast(:" + p + " as jsonb)");
        }
        sql.append(" and data #> ").append(path).append(" in (").append(String.join(", ", ph)).append(")");
      } else {
        String p = "v" + i++;
        params.put(p, write(f.value()));
        sql.append(" and data #> ").append(path).append(' ').append(f.op().sql).append(" cast(:").append(p).append(" as jsonb)");
      }
    }
    if (extraWhere != null) {
      sql.append(" and (").append(extraWhere.sql()).append(')');
      params.putAll(extraWhere.params());
    }
    for (Query.Order o : query.orders()) sql.append(" and data #> ").append(path(o.field())).append(" is not null");
    List<String> order = new ArrayList<>();
    for (Query.Order o : query.orders()) order.add("data #> " + path(o.field()) + (o.desc() ? " desc" : " asc"));
    order.add("id");
    sql.append(" order by ").append(String.join(", ", order));
    if (query.limit() != null) sql.append(" limit ").append(Math.max(0, Math.min(query.limit(), 10_000)));
    if (lock && !EMPLOYEES.equals(c)) sql.append(" for update");
    var stmt = db.sql(sql.toString());
    for (var e : params.entrySet()) stmt = stmt.param(e.getKey(), e.getValue());
    return stmt.query(String.class).list().stream().map(this::read).toList();
  }

  /** An SQL condition on the record ("data"), e.g. a read permission, with named params. */
  public record Condition(String sql, Map<String, Object> params) {}

  // ---------------------------------------------------------------- writes

  /** Creates or replaces a record. "id" is always set to the record id. */
  public void set(String b, String c, String id, Map<String, Object> data) {
    check(c, id);
    if (EMPLOYEES.equals(c)) throw new IllegalArgumentException("employees are written through StaffService");
    Map<String, Object> resolved = resolve(data);
    resolved.put("id", id);
    db.sql("""
        insert into docs (business_id, collection, id, data) values (:b, :c, :id, cast(:d as jsonb))
        on conflict (business_id, collection, id) do update set data = excluded.data, updated_at = now()""")
        .param("b", b).param("c", c).param("id", id).param("d", write(resolved)).update();
    feed.changed(b, c);
  }

  /** Creates a record; fails if it exists already. */
  public void create(String b, String c, String id, Map<String, Object> data) {
    check(c, id);
    Map<String, Object> resolved = resolve(data);
    resolved.put("id", id);
    int n = db.sql("insert into docs (business_id, collection, id, data) values (:b, :c, :id, cast(:d as jsonb)) on conflict do nothing")
        .param("b", b).param("c", c).param("id", id).param("d", write(resolved)).update();
    if (n == 0) throw ApiException.exists("Already exists");
    feed.changed(b, c);
  }

  /** Changes fields of an existing record. Keys may be dotted paths ("refund.decidedBy"); values may be {@link Op}s. */
  public void update(String b, String c, String id, Map<String, ?> changes) {
    if (EMPLOYEES.equals(c)) {
      updateEmployeeProfile(b, id, changes);
      return;
    }
    Map<String, Object> current = getForUpdate(b, c, id).orElseThrow(() -> ApiException.notFound("Record not found: " + c + "/" + id));
    for (var e : changes.entrySet()) apply(current, e.getKey(), e.getValue());
    save(b, c, id, current);
  }

  /** Like Firestore set(…, {merge: true}): nested maps are merged, the record is created if missing. */
  public void merge(String b, String c, String id, Map<String, ?> changes) {
    if (EMPLOYEES.equals(c)) {
      updateEmployeeProfile(b, id, changes);
      return;
    }
    // Create an empty record first so concurrent merges (e.g. two sales bumping the same day's stats)
    // queue on the row lock instead of both inserting and one overwriting the other.
    check(c, id);
    db.sql("insert into docs (business_id, collection, id, data) values (:b, :c, :id, cast(:d as jsonb)) on conflict do nothing")
        .param("b", b).param("c", c).param("id", id).param("d", write(Map.of("id", id))).update();
    Map<String, Object> current = getForUpdate(b, c, id).orElseGet(LinkedHashMap::new);
    deepMerge(current, changes);
    current.put("id", id);
    save(b, c, id, current);
  }

  public void delete(String b, String c, String id) {
    check(c, id);
    db.sql("delete from docs where business_id = :b and collection = :c and id = :id").param("b", b).param("c", c).param("id", id).update();
    feed.changed(b, c);
  }

  private void save(String b, String c, String id, Map<String, Object> data) {
    db.sql("""
        insert into docs (business_id, collection, id, data) values (:b, :c, :id, cast(:d as jsonb))
        on conflict (business_id, collection, id) do update set data = excluded.data, updated_at = now()""")
        .param("b", b).param("c", c).param("id", id).param("d", write(data)).update();
    feed.changed(b, c);
  }

  private void updateEmployeeProfile(String b, String uid, Map<String, ?> changes) {
    String profile = db.sql("select profile::text from memberships where business_id = :b and user_id = :u for update")
        .param("b", b).param("u", uid).query(String.class).optional()
        .orElseThrow(() -> ApiException.notFound("Employee not found"));
    Map<String, Object> p = read(profile);
    for (var e : changes.entrySet()) {
      if (EMPLOYEE_CORE.contains(e.getKey().split("\\.")[0])) throw new IllegalArgumentException("Change " + e.getKey() + " through StaffService");
      apply(p, e.getKey(), e.getValue());
    }
    db.sql("update memberships set profile = cast(:p as jsonb) where business_id = :b and user_id = :u")
        .param("p", write(p)).param("b", b).param("u", uid).update();
    feed.changed(b, EMPLOYEES);
  }

  // ---------------------------------------------------------------- global records (outside a shop)

  public Optional<Map<String, Object>> getGlobal(String c, String id) {
    return db.sql("select data from global_docs where collection = :c and id = :id").param("c", c).param("id", id)
        .query(String.class).optional().map(this::read);
  }

  public void setGlobal(String c, String id, Map<String, Object> data) {
    db.sql("""
        insert into global_docs (collection, id, data) values (:c, :id, cast(:d as jsonb))
        on conflict (collection, id) do update set data = excluded.data, updated_at = now()""")
        .param("c", c).param("id", id).param("d", write(resolve(data))).update();
  }

  // ---------------------------------------------------------------- helpers

  /** Where a collection's records come from: the docs table, or the staff view over memberships. */
  private static String source(String c) {
    if (EMPLOYEES.equals(c)) {
      return """
          select m.user_id as id, jsonb_build_object(
              'id', m.user_id, 'uid', m.user_id, 'displayName', m.display_name, 'email', u.email,
              'phone', coalesce(m.phone, ''), 'role', m.role, 'active', m.active and not u.disabled,
              'createdBy', m.created_by,
              'createdAt', jsonb_build_object('__ts', (extract(epoch from m.created_at) * 1000)::bigint)) || m.profile as data
          from memberships m join users u on u.id = m.user_id
          where m.business_id = :b and :c = :c""";
    }
    return "select id, data from docs where business_id = :b and collection = :c";
  }

  private static String path(String field) {
    if (!FIELD.matcher(field).matches()) throw ApiException.invalid("Invalid field " + field);
    return "'{" + field.replace('.', ',') + "}'";
  }

  private static void check(String c, String id) {
    if (!NAME.matcher(c).matches()) throw ApiException.invalid("Invalid collection");
    if (id != null && !NAME.matcher(id).matches()) throw ApiException.invalid("Invalid id");
  }

  private Map<String, Object> read(String s) {
    return json.readValue(s, MAP);
  }

  private String write(Object value) {
    return json.writeValueAsString(value);
  }

  /** Replaces Ops (server time) in a new record; nested maps too. */
  @SuppressWarnings("unchecked")
  private static Map<String, Object> resolve(Map<String, ?> data) {
    Map<String, Object> out = new LinkedHashMap<>();
    for (var e : data.entrySet()) {
      Object v = e.getValue();
      if (v instanceof Op.ServerTime) v = Ts.now();
      else if (v instanceof Op.Inc inc) v = number(inc.by());
      else if (v instanceof Op.Delete) continue;
      else if (v instanceof Map<?, ?> m && !Ts.is(m)) v = resolve((Map<String, ?>) m);
      out.put(e.getKey(), v);
    }
    return out;
  }

  @SuppressWarnings("unchecked")
  static void apply(Map<String, Object> target, String dottedPath, Object value) {
    String[] parts = dottedPath.split("\\.");
    Map<String, Object> cur = target;
    for (int i = 0; i < parts.length - 1; i++) {
      Object next = cur.get(parts[i]);
      if (!(next instanceof Map<?, ?>)) {
        next = new LinkedHashMap<String, Object>();
        cur.put(parts[i], next);
      } else if (!(next instanceof LinkedHashMap<?, ?>)) {
        next = new LinkedHashMap<>((Map<String, Object>) next);
        cur.put(parts[i], next);
      }
      cur = (Map<String, Object>) next;
    }
    String key = parts[parts.length - 1];
    switch (value) {
      case null -> cur.put(key, null);
      case Op.Delete d -> cur.remove(key);
      case Op.ServerTime t -> cur.put(key, Ts.now());
      case Op.Inc inc -> cur.put(key, number(toDouble(cur.get(key)) + inc.by()));
      case Map<?, ?> m when !Ts.is(m) -> cur.put(key, resolve((Map<String, ?>) m));
      default -> cur.put(key, value);
    }
  }

  /** Firestore merge semantics: keys are literal field names; nested maps merge; Ops apply. */
  @SuppressWarnings("unchecked")
  private static void deepMerge(Map<String, Object> target, Map<String, ?> changes) {
    for (var e : changes.entrySet()) {
      String key = e.getKey();
      Object v = e.getValue();
      if (v instanceof Map<?, ?> m && !Ts.is(m)) {
        Map<String, Object> nested = target.get(key) instanceof Map<?, ?> existing && !Ts.is(existing)
            ? new LinkedHashMap<>((Map<String, Object>) existing)
            : new LinkedHashMap<>();
        deepMerge(nested, (Map<String, ?>) m);
        target.put(key, nested);
      } else {
        switch (v) {
          case null -> target.put(key, null);
          case Op.Delete d -> target.remove(key);
          case Op.ServerTime t -> target.put(key, Ts.now());
          case Op.Inc inc -> target.put(key, number(toDouble(target.get(key)) + inc.by()));
          default -> target.put(key, v);
        }
      }
    }
  }

  private static double toDouble(Object v) {
    return v instanceof Number n ? n.doubleValue() : 0;
  }

  /** Whole numbers stay integers in JSON (money is integer cents). */
  private static Object number(double d) {
    return d == Math.rint(d) && Math.abs(d) < 9e15 ? (Object) (long) d : (Object) d;
  }
}
