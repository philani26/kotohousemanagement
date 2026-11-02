package za.co.kotahouse.bridge;

import java.util.Map;

/**
 * Keeps modules that still run on Firebase working while the backend moves to
 * Java (docs/JAVA-MIGRATION.md). PostgreSQL is the source of truth; this only
 * mirrors one way into Firebase and is removed at switch-off.
 */
public interface FirebaseBridge {

  /** A Firebase custom token carrying the same shops and roles, so the app can still use Firestore. null when off. */
  String customToken(String uid, Map<String, String> roles, String defaultBusinessId);

  /** Keeps the Firebase login, claims and the Firestore employee/user documents in step with PostgreSQL. */
  void syncMember(Member m);

  /** A new shop: its Firestore business and settings documents. */
  void shopCreated(String businessId, String name, String ownerUid);

  /** Password changed in Java: also changed on the old Firebase login, so a roll-back keeps working. */
  void passwordChanged(String uid, String newPassword);

  record Member(
      String uid,
      String email,
      String displayName,
      String phone,
      String businessId,
      String businessName,
      String role,
      boolean active,
      boolean userDisabled,
      String createdBy,
      /** every shop and role of this person, for the custom claims */
      Map<String, String> roles,
      String defaultBusinessId,
      /** only when creating the login */
      String password) {}

  /** Bridge switched off (tests, or after switch-off). */
  class Off implements FirebaseBridge {
    @Override
    public String customToken(String uid, Map<String, String> roles, String defaultBusinessId) {
      return null;
    }

    @Override
    public void syncMember(Member m) {}

    @Override
    public void shopCreated(String businessId, String name, String ownerUid) {}

    @Override
    public void passwordChanged(String uid, String newPassword) {}
  }
}
