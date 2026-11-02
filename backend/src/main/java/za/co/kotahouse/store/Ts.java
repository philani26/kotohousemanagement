package za.co.kotahouse.store;

import java.time.Instant;
import java.util.Map;

/**
 * Timestamps inside records are stored as {"__ts": epochMillis}, the app turns
 * them back into Timestamp objects (toDate/toMillis) like Firestore's.
 */
public final class Ts {
  public static final String KEY = "__ts";

  private Ts() {}

  public static Map<String, Object> of(long millis) {
    return Map.of(KEY, millis);
  }

  public static Map<String, Object> of(Instant at) {
    return of(at.toEpochMilli());
  }

  public static Map<String, Object> now() {
    return of(System.currentTimeMillis());
  }

  /** Millis of a stored timestamp, or null when the value isn't one. */
  public static Long millis(Object value) {
    if (value instanceof Map<?, ?> m && m.get(KEY) instanceof Number n) return n.longValue();
    return null;
  }

  public static boolean is(Object value) {
    return millis(value) != null;
  }
}
