package za.co.kotahouse.domain;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.Map;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Yoco card payments on the customer's phone (port of shared/yoco.ts):
 * the webhook signature check and whether a checkout may pay a sale.
 */
public final class Yoco {
  private Yoco() {}

  public static final String API = "https://payments.yoco.com/api";

  /** "live", "test" or null for anything that isn't a secret key */
  public static String keyMode(String secretKey) {
    if (secretKey == null) return null;
    if (secretKey.matches("^sk_live_[A-Za-z0-9]{10,}$")) return "live";
    if (secretKey.matches("^sk_test_[A-Za-z0-9]{10,}$")) return "test";
    return null;
  }

  /**
   * Standard Webhooks check, as Yoco documents it: HMAC-SHA256 over
   * "id.timestamp.rawBody" with the base64 key after "whsec_", compared to any
   * "v1,signature" entry; the timestamp must be within 3 minutes.
   */
  public static boolean signatureOk(String secret, String id, String timestamp, String body, String signature, long nowSeconds) {
    if (secret == null || !secret.startsWith("whsec_") || id == null || timestamp == null || signature == null) return false;
    long ts;
    try {
      ts = Long.parseLong(timestamp);
    } catch (NumberFormatException e) {
      return false;
    }
    if (Math.abs(nowSeconds - ts) > 180) return false;
    byte[] expected;
    try {
      Mac mac = Mac.getInstance("HmacSHA256");
      mac.init(new SecretKeySpec(Base64.getDecoder().decode(secret.substring(6)), "HmacSHA256"));
      expected = Base64.getEncoder().encode(mac.doFinal((id + "." + timestamp + "." + body).getBytes(StandardCharsets.UTF_8)));
    } catch (GeneralSecurityException | IllegalArgumentException e) {
      return false;
    }
    for (String entry : signature.split(" ")) {
      String[] parts = entry.split(",", 2);
      if (parts.length == 2 && parts[0].equals("v1") && MessageDigest.isEqual(parts[1].getBytes(StandardCharsets.UTF_8), expected)) return true;
    }
    return false;
  }

  /** Why a checkout can't pay for this sale, or null if it can. */
  public static String checkoutProblem(Map<String, Object> c, String saleId, long amountCents) {
    if (c == null) return "Card payment not found";
    if (!saleId.equals(c.get("saleId"))) return "That card payment belongs to another sale";
    Object used = c.get("usedBySale");
    if (used != null && !saleId.equals(used)) return "That card payment was already used";
    if (!"paid".equals(c.get("status"))) return "The customer has not finished paying yet";
    if (Domain.cents(c.get("amountCents")) != amountCents) return "The customer paid a different amount – start the card payment again";
    return null;
  }
}
