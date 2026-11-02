package za.co.kotahouse.common;

import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.Locale;

/** Shop dates in the shop's time zone (ported from dayKey/localHour/localWeekday in domain.ts). */
public final class Days {
  private static final DateTimeFormatter DAY = DateTimeFormatter.ofPattern("yyyy-MM-dd");
  private static final DateTimeFormatter LOCAL = DateTimeFormatter.ofPattern("EEE d MMM, HH:mm", Locale.forLanguageTag("en-ZA"));

  private Days() {}

  static ZonedDateTime at(Instant when, String timeZone) {
    return when.atZone(ZoneId.of(timeZone == null || timeZone.isBlank() ? "Africa/Johannesburg" : timeZone));
  }

  /** "2026-11-02" */
  public static String dayKey(Instant when, String timeZone) {
    return at(when, timeZone).format(DAY);
  }

  public static int localHour(Instant when, String timeZone) {
    return at(when, timeZone).getHour();
  }

  /** 0 = Sunday … 6 = Saturday, like JavaScript */
  public static int localWeekday(Instant when, String timeZone) {
    return at(when, timeZone).getDayOfWeek().getValue() % 7;
  }

  /** "Mon 27 Oct, 14:05" for alert details */
  public static String localTime(Instant when, String timeZone) {
    return at(when, timeZone).format(LOCAL);
  }
}
