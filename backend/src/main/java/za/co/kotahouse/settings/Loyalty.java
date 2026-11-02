package za.co.kotahouse.settings;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Stamp-card rules (port of functions/src/shared/loyalty.ts). A sale of at
 * least minSpendCents earns a stamp; stampsNeeded stamps give up to
 * rewardValueCents off a sale.
 */
public record Loyalty(boolean enabled, int stampsNeeded, long minSpendCents, long rewardValueCents) {

  public static final Loyalty DEFAULT = new Loyalty(false, 9, 3000, 4000);

  /** The owner writes these settings directly, so keep them within sane limits. */
  public static Map<String, Object> clean(Map<String, Object> s) {
    Loyalty l = of(s);
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("enabled", l.enabled());
    out.put("stampsNeeded", l.stampsNeeded());
    out.put("minSpendCents", l.minSpendCents());
    out.put("rewardValueCents", l.rewardValueCents());
    return out;
  }

  public static Loyalty of(Map<String, Object> s) {
    return new Loyalty(
        Boolean.TRUE.equals(s.get("enabled")),
        (int) clamp(s.get("stampsNeeded"), 1, 50, DEFAULT.stampsNeeded()),
        clamp(s.get("minSpendCents"), 0, 1_000_000, DEFAULT.minSpendCents()),
        clamp(s.get("rewardValueCents"), 0, 100_000, DEFAULT.rewardValueCents()));
  }

  private static long clamp(Object v, long min, long max, long fallback) {
    if (!(v instanceof Number n) || !Double.isFinite(n.doubleValue())) return fallback;
    return Math.max(min, Math.min(max, Math.round(n.doubleValue())));
  }

  /** 082 123 4567 / +27 82 123 4567 / 27821234567 → 27821234567; null if not a SA mobile number. */
  public static String normalisePhone(Object input) {
    String d = String.valueOf(input == null ? "" : input).replaceAll("\\D", "");
    if (d.matches("^0\\d{9}$")) d = "27" + d.substring(1);
    return d.matches("^27[6-8]\\d{8}$") ? d : null;
  }

  public boolean rewardReady(Number stamps) {
    return stamps != null && enabled && stamps.intValue() >= stampsNeeded;
  }

  public record Outcome(long rewardCents, boolean stamped, int stampsAfter) {}

  /** What a sale does to the customer's card; totalCents is before the reward. */
  public Outcome outcome(Number currentStamps, long totalCents, boolean redeem) {
    int stamps = currentStamps == null ? 0 : currentStamps.intValue();
    if (!enabled) return new Outcome(0, false, stamps);
    boolean redeeming = redeem && stamps >= stampsNeeded;
    long reward = redeeming ? Math.min(rewardValueCents, totalCents) : 0;
    boolean stamped = totalCents - reward >= minSpendCents;
    return new Outcome(reward, stamped, stamps - (redeeming ? stampsNeeded : 0) + (stamped ? 1 : 0));
  }
}
