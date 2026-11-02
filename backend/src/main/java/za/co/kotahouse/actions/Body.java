package za.co.kotahouse.actions;

import java.util.List;
import java.util.Map;
import za.co.kotahouse.common.ApiException;
import za.co.kotahouse.domain.Domain;

/**
 * A request body, read with the same checks and messages as the Cloud
 * Functions (assertCents, requireText, optionalText…). The app sends the same
 * JSON it sent to the callables.
 */
public record Body(Map<String, Object> data) {

  public static Body of(Map<String, Object> data) {
    return new Body(data == null ? Map.of() : data);
  }

  public Object raw(String key) {
    return data.get(key);
  }

  public boolean has(String key) {
    return data.get(key) != null;
  }

  /** assertCents: a whole number of cents within [min, max]. */
  public long cents(String key, String label, long min, long max) {
    Object v = data.get(key);
    if (!(v instanceof Number n) || n.doubleValue() != Math.rint(n.doubleValue()) || n.longValue() < min || n.longValue() > max) {
      throw ApiException.invalid(label + " must be a whole number of cents between " + min + " and " + max);
    }
    return n.longValue();
  }

  public long cents(String key, String label) {
    return cents(key, label, 0, 100_000_000);
  }

  /** null when absent */
  public Long optCents(String key, String label, long min, long max) {
    return data.get(key) == null ? null : cents(key, label, min, max);
  }

  public String text(String key, String label, int min, int max) {
    return Domain.requireText(data.get(key), label, min, max);
  }

  public String optText(String key, String label, int max) {
    return Domain.optionalText(data.get(key), label, max);
  }

  public String str(String key) {
    Object v = data.get(key);
    return v == null ? "" : v.toString();
  }

  public Long optLong(String key) {
    return data.get(key) instanceof Number n ? n.longValue() : null;
  }

  public Double optNumber(String key) {
    return data.get(key) instanceof Number n ? n.doubleValue() : null;
  }

  public boolean bool(String key) {
    return Boolean.TRUE.equals(data.get(key));
  }

  @SuppressWarnings("unchecked")
  public Body obj(String key) {
    return Body.of(data.get(key) instanceof Map<?, ?> m ? (Map<String, Object>) m : Map.of());
  }

  @SuppressWarnings("unchecked")
  public List<Object> list(String key) {
    return data.get(key) instanceof List<?> l ? (List<Object>) l : List.of();
  }

  public List<Map<String, Object>> objects(String key) {
    return Domain.list(data.get(key));
  }
}
