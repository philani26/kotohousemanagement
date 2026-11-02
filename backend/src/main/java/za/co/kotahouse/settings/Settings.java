package za.co.kotahouse.settings;

import java.util.List;
import java.util.Map;

/**
 * A shop's settings (businessSettings/main) with the defaults filled in.
 * The full record stays a map (the app reads all of it); the server reads the
 * fields it needs through these accessors.
 */
public record Settings(Map<String, Object> data) {

  public String businessName() {
    return str(data.get("businessName"), "Kota House");
  }

  public String timezone() {
    return str(data.get("timezone"), "Africa/Johannesburg");
  }

  public int openingHour() {
    return num(data.get("openingHour"), 9);
  }

  public int closingHour() {
    return num(data.get("closingHour"), 20);
  }

  public double maxEmployeeDiscountPercent() {
    return dbl(data.get("maxEmployeeDiscountPercent"), 0);
  }

  @SuppressWarnings("unchecked")
  public Map<String, Object> section(String name) {
    return data.get(name) instanceof Map<?, ?> m ? (Map<String, Object>) m : Map.of();
  }

  /** e.g. threshold("cashDiscrepancyCents") */
  public double threshold(String key) {
    return dbl(section("thresholds").get(key), 0);
  }

  public boolean flag(String section, String key) {
    return Boolean.TRUE.equals(section(section).get(key));
  }

  public double number(String section, String key, double fallback) {
    return dbl(section(section).get(key), fallback);
  }

  public String text(String section, String key) {
    return str(section(section).get(key), "");
  }

  @SuppressWarnings("unchecked")
  public List<String> emailTo() {
    return section("notifications").get("emailTo") instanceof List<?> l ? (List<String>) l : List.of();
  }

  static String str(Object v, String fallback) {
    return v instanceof String s && !s.isBlank() ? s : fallback;
  }

  static int num(Object v, int fallback) {
    return v instanceof Number n ? n.intValue() : fallback;
  }

  static double dbl(Object v, double fallback) {
    return v instanceof Number n ? n.doubleValue() : fallback;
  }
}
