package za.co.kotahouse.auth;

import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import za.co.kotahouse.bridge.FirebaseBridge;
import za.co.kotahouse.common.ApiException;
import za.co.kotahouse.common.Ids;
import za.co.kotahouse.common.Text;
import za.co.kotahouse.config.AppProperties;
import za.co.kotahouse.shop.ShopAccess;

@Service
public class AuthService {
  private static final Duration RESET_TTL = Duration.ofHours(1);

  private final JdbcClient db;
  private final PasswordHasher hasher;
  private final TokenService tokens;
  private final ShopAccess shops;
  private final FirebaseBridge bridge;
  private final Mailer mailer;
  private final AppProperties props;

  public AuthService(JdbcClient db, PasswordHasher hasher, TokenService tokens, ShopAccess shops, FirebaseBridge bridge, Mailer mailer, AppProperties props) {
    this.db = db;
    this.hasher = hasher;
    this.tokens = tokens;
    this.shops = shops;
    this.bridge = bridge;
    this.mailer = mailer;
    this.props = props;
  }

  public record UserInfo(String uid, String email, String displayName) {}

  /** What the app needs after signing in or refreshing. */
  public record Session(
      String accessToken,
      String refreshToken,
      long expiresIn,
      UserInfo user,
      List<ShopAccess.Membership> memberships,
      /** Firebase custom token for modules still on Firestore; null once the bridge is off */
      String firebaseToken) {}

  record UserRow(String id, String email, String displayName, String algo, String hash, String salt, boolean disabled) {}

  private UserRow findByEmail(String email) {
    return db.sql("select id, email, display_name, password_algo, password_hash, password_salt, disabled from users where email = :e")
        .param("e", email)
        .query((rs, i) -> new UserRow(rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4), rs.getString(5), rs.getString(6), rs.getBoolean(7)))
        .optional()
        .orElse(null);
  }

  private UserRow findById(String uid) {
    return db.sql("select id, email, display_name, password_algo, password_hash, password_salt, disabled from users where id = :id")
        .param("id", uid)
        .query((rs, i) -> new UserRow(rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4), rs.getString(5), rs.getString(6), rs.getBoolean(7)))
        .optional()
        .orElseThrow(() -> ApiException.unauthenticated("Please sign in again"));
  }

  /** Same message for unknown email and wrong password, so nobody can find out which emails have logins. */
  private static ApiException wrongCredentials() {
    return new ApiException(HttpStatus.UNAUTHORIZED, "invalid-credential", "Email or password is incorrect");
  }

  @Transactional
  public Session login(String emailIn, String password) {
    String email = emailIn == null ? "" : emailIn.trim().toLowerCase();
    UserRow u = findByEmail(email);
    if (u == null || password == null) {
      hasher.burnTime(password == null ? "" : password);
      throw wrongCredentials();
    }
    if (!hasher.matches(password, u.algo(), u.hash(), u.salt())) throw wrongCredentials();
    if (u.disabled()) throw new ApiException(HttpStatus.FORBIDDEN, "user-disabled", "This account has been deactivated. Speak to the owner.");
    // Passwords imported from Firebase are upgraded to Argon2id the first time they are used.
    if (!PasswordHasher.ARGON2.equals(u.algo())) setPassword(u.id(), password);
    return session(u, tokens.issue(u.id()));
  }

  // A refused refresh still saves the revocations it made (token re-use, deactivated account).
  @Transactional(noRollbackFor = ApiException.class)
  public Session refresh(String refreshToken) {
    if (refreshToken == null || refreshToken.isBlank()) throw ApiException.unauthenticated("Please sign in again");
    TokenService.RotateResult r = tokens.rotate(refreshToken);
    UserRow u = findById(r.uid());
    if (u.disabled()) {
      tokens.revokeAll(u.id());
      throw new ApiException(HttpStatus.FORBIDDEN, "user-disabled", "This account has been deactivated. Speak to the owner.");
    }
    return session(u, r.tokens());
  }

  public void logout(String refreshToken) {
    if (refreshToken != null && !refreshToken.isBlank()) tokens.revoke(refreshToken);
  }

  /** A new owner signs up; they create their first shop next (POST /api/businesses). */
  @Transactional
  public Session signup(String emailIn, String password, String displayNameIn) {
    String email = Text.email(emailIn);
    String pw = Text.newPassword(password);
    String displayName = Text.personName(displayNameIn == null || displayNameIn.isBlank() ? "Owner" : displayNameIn);
    if (findByEmail(email) != null) throw ApiException.exists("An account with this email already exists – sign in instead");
    String uid = Ids.uid();
    db.sql("insert into users (id, email, display_name, password_algo, password_hash) values (:id, :e, :n, :a, :h)")
        .param("id", uid).param("e", email).param("n", displayName).param("a", PasswordHasher.ARGON2).param("h", hasher.hash(pw))
        .update();
    return session(findById(uid), tokens.issue(uid));
  }

  public Session me(String uid) {
    UserRow u = findById(uid);
    return new Session(null, null, 0, new UserInfo(u.id(), u.email(), u.displayName()), shops.memberships(uid), firebaseToken(uid));
  }

  public String firebaseToken(String uid) {
    var ms = shops.memberships(uid);
    return bridge.customToken(uid, ShopAccess.roles(ms), ms.isEmpty() ? null : ms.get(0).businessId());
  }

  private Session session(UserRow u, TokenService.Tokens t) {
    return new Session(t.accessToken(), t.refreshToken(), t.expiresInSeconds(), new UserInfo(u.id(), u.email(), u.displayName()), shops.memberships(u.id()), firebaseToken(u.id()));
  }

  /** Sets a new Argon2id password (no session changes). */
  public void setPassword(String uid, String password) {
    db.sql("update users set password_algo = :a, password_hash = :h, password_salt = null where id = :id")
        .param("a", PasswordHasher.ARGON2).param("h", hasher.hash(password)).param("id", uid).update();
  }

  /** Always succeeds from the outside, whether or not the email has a login. */
  @Transactional
  public void requestPasswordReset(String emailIn) {
    String email = emailIn == null ? "" : emailIn.trim().toLowerCase();
    UserRow u = findByEmail(email);
    if (u == null || u.disabled()) return;
    String token = TokenService.randomToken();
    db.sql("insert into password_resets (token_hash, user_id, expires_at) values (:h, :u, :exp)")
        .param("h", TokenService.sha256(token)).param("u", u.id()).param("exp", Timestamp.from(Instant.now().plus(RESET_TTL)))
        .update();
    mailer.send(u.email(), "Reset your Kota House password",
        "Hi " + u.displayName() + ",\n\nSomeone asked to reset your Kota House password. If it was you, open this link within an hour:\n\n"
            + props.appUrl() + "/reset-password?token=" + token
            + "\n\nIf it wasn't you, ignore this email – your password stays the same.");
  }

  @Transactional
  public void confirmPasswordReset(String token, String newPassword) {
    String pw = Text.newPassword(newPassword);
    String uid = db.sql("select user_id from password_resets where token_hash = :h and used_at is null and expires_at > now() for update")
        .param("h", TokenService.sha256(token == null ? "" : token))
        .query(String.class)
        .optional()
        .orElseThrow(() -> ApiException.invalid("This reset link is wrong or has expired – ask for a new one"));
    db.sql("update password_resets set used_at = now() where token_hash = :h").param("h", TokenService.sha256(token)).update();
    setPassword(uid, pw);
    tokens.revokeAll(uid); // sign out everywhere
    bridge.passwordChanged(uid, pw);
  }
}
