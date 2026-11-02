package za.co.kotahouse.domain;

/**
 * Work-site check (port of shared/geo.ts). Only the distance from the shop is
 * ever stored, never where the person was.
 */
public final class Geo {
  private Geo() {}

  public static final int SITE_CHECK_HOURS = 12;
  /** readings less precise than this are refused – usually GPS is off */
  public static final double MAX_ACCURACY_M = 300;

  public static boolean isValidPoint(Double lat, Double lng) {
    return lat != null && lng != null && Double.isFinite(lat) && Double.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  }

  /** Great-circle distance in metres (haversine). */
  public static long distanceM(double lat1, double lng1, double lat2, double lng2) {
    double r = 6_371_000;
    double dLat = Math.toRadians(lat2 - lat1);
    double dLng = Math.toRadians(lng2 - lng1);
    double h = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2)) * Math.pow(Math.sin(dLng / 2), 2);
    return Math.round(2 * r * Math.asin(Math.sqrt(h)));
  }

  /** ok, or the reason: inaccurate, outside, not-configured. */
  public record Decision(boolean ok, String reason, Long distanceM) {}

  /**
   * A small part of the phone's reported accuracy (up to 50 m) is allowed on
   * top of the radius, so a person in the shop with a fuzzy GPS fix isn't locked out.
   */
  public static Decision decide(boolean enabled, Double fenceLat, Double fenceLng, double radiusM, double lat, double lng, Double accuracyM) {
    if (!enabled) return new Decision(true, null, 0L);
    if (!isValidPoint(fenceLat, fenceLng)) return new Decision(false, "not-configured", null);
    if (accuracyM == null || !Double.isFinite(accuracyM) || accuracyM > MAX_ACCURACY_M) return new Decision(false, "inaccurate", null);
    long d = distanceM(fenceLat, fenceLng, lat, lng);
    return d <= radiusM + Math.min(Math.max(accuracyM, 0), 50) ? new Decision(true, null, d) : new Decision(false, "outside", d);
  }

  /** "850 m" / "3.2 km" */
  public static String formatDistance(double m) {
    return m < 1000 ? Math.round(m) + " m" : String.format("%.1f km", m / 1000);
  }
}
