package za.co.kotahouse.settings;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.stereotype.Service;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;
import za.co.kotahouse.store.Store;

/** Reads a shop's settings with defaults (ported from withSettingsDefaults / readSettings in common.ts). */
@Service
public class SettingsService {
  public static final String COLLECTION = "businessSettings";
  public static final String DOC = "main";
  /** sections merged one level deep with their defaults */
  private static final String[] SECTIONS = {"thresholds", "notifications", "cctv", "whatsapp", "geofence", "devices", "yoco"};

  private final Store store;
  private final Map<String, Object> defaults;

  public SettingsService(Store store, JsonMapper json) {
    this.store = store;
    try (InputStream in = getClass().getResourceAsStream("/defaults/settings.json")) {
      this.defaults = json.readValue(in, new TypeReference<Map<String, Object>>() {});
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }

  /** A copy of the default settings (for a new shop). */
  public Map<String, Object> defaults() {
    return new LinkedHashMap<>(defaults);
  }

  public Settings read(String businessId) {
    return withDefaults(store.get(businessId, COLLECTION, DOC).orElse(Map.of()));
  }

  @SuppressWarnings("unchecked")
  public Settings withDefaults(Map<String, Object> stored) {
    Map<String, Object> out = new LinkedHashMap<>(defaults);
    out.putAll(stored);
    for (String s : SECTIONS) {
      Map<String, Object> merged = new LinkedHashMap<>(defaults.get(s) instanceof Map<?, ?> d ? (Map<String, Object>) d : Map.of());
      if (stored.get(s) instanceof Map<?, ?> m) merged.putAll((Map<String, Object>) m);
      out.put(s, merged);
    }
    out.put("loyalty", Loyalty.clean(stored.get("loyalty") instanceof Map<?, ?> m ? (Map<String, Object>) m : Map.of()));
    return new Settings(out);
  }
}
