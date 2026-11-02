package za.co.kotahouse.auth;

import org.springframework.security.crypto.argon2.Argon2PasswordEncoder;
import org.springframework.stereotype.Component;
import za.co.kotahouse.config.AppProperties;

/** Argon2id for all new passwords; Firebase scrypt only to check passwords imported from Firebase. */
@Component
public class PasswordHasher {
  public static final String ARGON2 = "argon2id";
  public static final String FIREBASE_SCRYPT = "firebase-scrypt";

  private final Argon2PasswordEncoder argon2 = Argon2PasswordEncoder.defaultsForSpringSecurity_v5_8();
  private final FirebaseScrypt.Params firebase;

  public PasswordHasher(AppProperties props) {
    AppProperties.Firebase f = props.firebase();
    this.firebase = new FirebaseScrypt.Params(f.signerKey(), f.saltSeparator(), f.rounds(), f.memCost());
  }

  public String hash(String password) {
    return argon2.encode(password);
  }

  public boolean matches(String password, String algo, String hash, String salt) {
    return switch (algo) {
      case ARGON2 -> argon2.matches(password, hash);
      case FIREBASE_SCRYPT -> FirebaseScrypt.verify(password, salt, hash, firebase);
      default -> false;
    };
  }

  /** A dummy check so unknown emails take as long as known ones (no account guessing by timing). */
  public void burnTime(String password) {
    argon2.matches(password, DUMMY);
  }

  private static final String DUMMY = Argon2PasswordEncoder.defaultsForSpringSecurity_v5_8().encode("not-a-real-password");
}
