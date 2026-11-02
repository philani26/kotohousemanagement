package za.co.kotahouse.common;

/** Input checks shared by all endpoints (ported from requireText/optionalText in functions/src/shared/domain.ts). */
public final class Text {
  private Text() {}

  public static String require(Object value, String label, int min, int max) {
    String s = value == null ? "" : value.toString().trim();
    if (s.length() < min) throw ApiException.invalid(label + " is required" + (min > 1 ? " (at least " + min + " characters)" : ""));
    if (s.length() > max) throw ApiException.invalid(label + " is too long (max " + max + " characters)");
    return s;
  }

  /** null when empty */
  public static String optional(Object value, String label, int max) {
    String s = value == null ? "" : value.toString().trim();
    if (s.isEmpty()) return null;
    if (s.length() > max) throw ApiException.invalid(label + " is too long (max " + max + " characters)");
    return s;
  }

  /** A person's name, not their email: an email here gets mistaken for the sign-in email. */
  public static String personName(Object value) {
    String name = require(value, "Name", 2, 60);
    if (name.contains("@")) throw ApiException.invalid("Name can't be an email – type the person's name, and their email in the Email box");
    return name;
  }

  public static String email(Object value) {
    String e = require(value, "Email", 5, 120).toLowerCase();
    if (!e.matches("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$")) throw ApiException.invalid("Enter a valid email address");
    return e;
  }

  public static String newPassword(Object value) {
    if (!(value instanceof String p) || p.length() < 8) throw ApiException.invalid("Password must be at least 8 characters");
    if (p.length() > 128) throw ApiException.invalid("Password is too long");
    return p;
  }
}
