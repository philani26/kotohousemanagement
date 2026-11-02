package za.co.kotahouse.auth;

import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.bouncycastle.crypto.generators.SCrypt;

/**
 * Checks passwords exported from Firebase Authentication, so staff keep their
 * passwords after the move. Firebase's modified scrypt
 * (https://github.com/firebase/scrypt):
 *   key  = scrypt(password, salt ‖ saltSeparator, N = 2^memCost, r = rounds, p = 1, 32 bytes)
 *   hash = AES-256-CTR(key, iv = 0) applied to the project's signer key
 */
public final class FirebaseScrypt {
  private FirebaseScrypt() {}

  public record Params(String signerKeyB64, String saltSeparatorB64, int rounds, int memCost) {
    public boolean configured() {
      return signerKeyB64 != null && !signerKeyB64.isBlank();
    }
  }

  public static boolean verify(String password, String saltB64, String expectedHashB64, Params p) {
    if (!p.configured() || saltB64 == null || expectedHashB64 == null) return false;
    try {
      byte[] hash = hash(password, saltB64, p);
      return MessageDigest.isEqual(hash, Base64.getDecoder().decode(expectedHashB64));
    } catch (IllegalArgumentException | GeneralSecurityException e) {
      return false;
    }
  }

  static byte[] hash(String password, String saltB64, Params p) throws GeneralSecurityException {
    Base64.Decoder b64 = Base64.getDecoder();
    byte[] salt = b64.decode(saltB64);
    byte[] separator = b64.decode(p.saltSeparatorB64());
    byte[] fullSalt = new byte[salt.length + separator.length];
    System.arraycopy(salt, 0, fullSalt, 0, salt.length);
    System.arraycopy(separator, 0, fullSalt, salt.length, separator.length);

    byte[] key = SCrypt.generate(password.getBytes(java.nio.charset.StandardCharsets.UTF_8), fullSalt, 1 << p.memCost(), p.rounds(), 1, 32);
    Cipher aes = Cipher.getInstance("AES/CTR/NoPadding");
    aes.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new IvParameterSpec(new byte[16]));
    return aes.doFinal(b64.decode(p.signerKeyB64()));
  }
}
