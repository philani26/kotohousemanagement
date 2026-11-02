package za.co.kotahouse.domain;

import java.time.LocalDate;
import java.time.ZoneId;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Shop devices and "Kota House off screen" time (port of shared/devices.ts). */
public final class Devices {
  private Devices() {}

  public static final int MAX_TRAIL = 40;
  public static final int INVITE_HOURS = 24;
  public static final int MAX_SPANS_KEPT = 60;
  /** ignore glances shorter than this (notifications, quick unlocks) */
  public static final long MIN_SPAN_MS = 30_000;

  public record Span(long from, long to) {}

  /** Keeps only the part of a span inside [start, end); null if too little is left. */
  public static Span clipSpan(Span s, long start, long end) {
    if (!(s.to() > s.from())) return null;
    long from = Math.max(s.from(), start);
    long to = Math.min(s.to(), end);
    return to - from >= MIN_SPAN_MS ? new Span(from, to) : null;
  }

  /** Epoch millis of a local hour on a shop day, in the shop's time zone. */
  public static long localTimeMillis(String dayKey, int hour, String timeZone) {
    return LocalDate.parse(dayKey).atStartOfDay(ZoneId.of(timeZone)).plusHours(hour).toInstant().toEpochMilli();
  }

  /** "Samsung SM-A146B · Chrome", "iPhone · Safari", "Windows PC · Edge" from a user-agent string. */
  public static String deviceLabel(String ua) {
    String browser = ua.matches("(?s).*EdgA?/.*") ? "Edge"
        : ua.contains("SamsungBrowser") ? "Samsung Internet"
        : ua.matches("(?s).*(CriOS|Chrome/).*") ? "Chrome"
        : ua.matches("(?s).*(Firefox|FxiOS).*") ? "Firefox"
        : ua.contains("Safari/") ? "Safari" : "Browser";
    Matcher android = Pattern.compile("Android[^;]*;\\s*([^;)]+?)(?:\\s+Build|\\))").matcher(ua);
    if (android.find()) {
      String model = android.group(1).trim();
      String brand = model.matches("^(SM-|GT-).*") ? "Samsung " : "";
      return (model.equals("K") ? "Android phone" : brand + model) + " · " + browser;
    }
    if (ua.contains("iPhone")) return "iPhone · " + browser;
    if (ua.contains("iPad") || ua.matches("(?s).*Macintosh.*Mobile.*")) return "iPad · " + browser;
    if (ua.contains("Windows")) return "Windows PC · " + browser;
    if (ua.contains("Macintosh")) return "Mac · " + browser;
    return "Device · " + browser;
  }

  /** "1 h 40 min" / "12 min" */
  public static String formatDuration(long ms) {
    long min = Math.round(ms / 60_000.0);
    return min >= 60 ? (min / 60) + " h " + (min % 60) + " min" : min + " min";
  }
}
