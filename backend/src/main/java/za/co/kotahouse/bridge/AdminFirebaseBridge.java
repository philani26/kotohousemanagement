package za.co.kotahouse.bridge;

import com.google.auth.oauth2.GoogleCredentials;
import com.google.cloud.firestore.FieldValue;
import com.google.cloud.firestore.Firestore;
import com.google.cloud.firestore.SetOptions;
import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;
import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseAuthException;
import com.google.firebase.auth.UserRecord;
import com.google.firebase.cloud.FirestoreClient;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.json.JsonMapper;

/**
 * The real bridge, using the Firebase Admin SDK with a service account
 * (GOOGLE_APPLICATION_CREDENTIALS). Mirrors exactly the documents the old
 * Cloud Functions wrote, so Firestore rules and remaining functions keep working.
 */
public class AdminFirebaseBridge implements FirebaseBridge {
  private static final Logger log = LoggerFactory.getLogger(AdminFirebaseBridge.class);

  private final FirebaseAuth auth;
  private final Firestore firestore;
  private final Map<String, Object> defaultSettings;

  @SuppressWarnings("unchecked")
  public AdminFirebaseBridge(String projectId, JsonMapper json) throws IOException {
    FirebaseOptions options = FirebaseOptions.builder()
        .setCredentials(GoogleCredentials.getApplicationDefault())
        .setProjectId(projectId)
        .build();
    FirebaseApp app = FirebaseApp.getApps().isEmpty() ? FirebaseApp.initializeApp(options) : FirebaseApp.getInstance();
    this.auth = FirebaseAuth.getInstance(app);
    this.firestore = FirestoreClient.getFirestore(app);
    try (InputStream in = getClass().getResourceAsStream("/bridge/default-settings.json")) {
      this.defaultSettings = json.readValue(in, Map.class);
    }
  }

  private static Map<String, Object> claims(Map<String, String> roles, String defaultBusinessId) {
    Map<String, Object> c = new HashMap<>();
    if (defaultBusinessId != null && roles.containsKey(defaultBusinessId)) {
      c.put("businessId", defaultBusinessId);
      c.put("role", roles.get(defaultBusinessId));
    }
    c.put("biz", new HashMap<>(roles));
    return c;
  }

  @Override
  public String customToken(String uid, Map<String, String> roles, String defaultBusinessId) {
    try {
      return auth.createCustomToken(uid, claims(roles, defaultBusinessId));
    } catch (FirebaseAuthException e) {
      throw new IllegalStateException("Could not create Firebase token", e);
    }
  }

  @Override
  public void syncMember(Member m) {
    try {
      if (m.password() != null) {
        try {
          auth.getUser(m.uid());
        } catch (FirebaseAuthException notFound) {
          auth.createUser(new UserRecord.CreateRequest().setUid(m.uid()).setEmail(m.email()).setPassword(m.password()).setDisplayName(m.displayName()));
        }
      }
      auth.updateUser(new UserRecord.UpdateRequest(m.uid()).setDisabled(m.userDisabled()).setDisplayName(m.displayName()));
      if (m.userDisabled()) auth.revokeRefreshTokens(m.uid());
      auth.setCustomUserClaims(m.uid(), claims(m.roles(), m.defaultBusinessId()));

      Map<String, Object> employee = new LinkedHashMap<>();
      employee.put("uid", m.uid());
      employee.put("displayName", m.displayName());
      employee.put("email", m.email());
      employee.put("phone", m.phone() == null ? "" : m.phone());
      employee.put("role", m.role());
      employee.put("active", m.active());
      employee.put("createdBy", m.createdBy());
      var empRef = firestore.collection("businesses").document(m.businessId()).collection("employees").document(m.uid());
      if (!empRef.get().get().exists()) employee.put("createdAt", FieldValue.serverTimestamp());
      empRef.set(employee, SetOptions.merge()).get();

      Map<String, Object> user = new LinkedHashMap<>();
      user.put("uid", m.uid());
      user.put("email", m.email());
      user.put("displayName", m.displayName());
      user.put("active", !m.userDisabled());
      if (m.defaultBusinessId() != null) {
        user.put("businessId", m.defaultBusinessId());
        user.put("role", m.roles().get(m.defaultBusinessId()));
      }
      user.put("memberships", Map.of(m.businessId(), Map.of("name", m.businessName(), "role", m.role())));
      firestore.collection("users").document(m.uid()).set(user, SetOptions.merge()).get();
    } catch (Exception e) {
      // PostgreSQL already has the change; a failed mirror is logged loudly and retried on the next change.
      log.error("Firebase bridge: could not mirror member {} of {}", m.uid(), m.businessId(), e);
    }
  }

  @Override
  public void shopCreated(String businessId, String name, String ownerUid) {
    try {
      var biz = firestore.collection("businesses").document(businessId);
      biz.set(Map.of("id", businessId, "name", name, "ownerUid", ownerUid, "receiptCounter", 0, "createdAt", FieldValue.serverTimestamp())).get();
      Map<String, Object> settings = new HashMap<>(defaultSettings);
      settings.put("businessName", name);
      settings.put("updatedAt", FieldValue.serverTimestamp());
      settings.put("updatedBy", ownerUid);
      biz.collection("businessSettings").document("main").set(settings).get();
    } catch (Exception e) {
      log.error("Firebase bridge: could not mirror new shop {}", businessId, e);
    }
  }

  @Override
  public void passwordChanged(String uid, String newPassword) {
    try {
      auth.updateUser(new UserRecord.UpdateRequest(uid).setPassword(newPassword));
      auth.revokeRefreshTokens(uid);
    } catch (Exception e) {
      log.error("Firebase bridge: could not mirror password change for {}", uid, e);
    }
  }
}
