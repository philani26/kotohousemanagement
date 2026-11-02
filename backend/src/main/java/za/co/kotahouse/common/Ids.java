package za.co.kotahouse.common;

import java.security.SecureRandom;

/** Ids in the same shape as Firestore's, so imported and new records look alike and Firestore mirrors accept them. */
public final class Ids {
  private static final String ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  private static final SecureRandom RANDOM = new SecureRandom();

  private Ids() {}

  /** 20 characters, like a Firestore document id */
  public static String doc() {
    return random(20);
  }

  /** 28 characters, like a Firebase Auth uid */
  public static String uid() {
    return random(28);
  }

  private static String random(int n) {
    StringBuilder sb = new StringBuilder(n);
    for (int i = 0; i < n; i++) sb.append(ALPHABET.charAt(RANDOM.nextInt(ALPHABET.length())));
    return sb.toString();
  }
}
