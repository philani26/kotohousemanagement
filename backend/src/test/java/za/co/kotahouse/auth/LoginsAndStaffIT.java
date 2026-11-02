package za.co.kotahouse.auth;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;
import za.co.kotahouse.ApiTestBase;

/** Phase 1 end to end: owner sign-up, shops, staff logins, tokens, deactivation, password reset, imported passwords. */
class LoginsAndStaffIT extends ApiTestBase {

  @Test
  void ownerSignsUpOpensAShopAndAddsStaff() {
    TestShop s = newShop();
    Res me = get("/api/me", s.owner().token());
    assertThat(me.status()).isEqualTo(200);
    assertThat((List<?>) me.get("memberships")).hasSize(1);
    assertThat(me.<String>get("user.displayName")).isEqualTo("Thandi");

    String staffPath = "/api/businesses/" + s.businessId() + "/staff";
    // an email as the name is refused (it gets mistaken for the sign-in email)
    Res bad = post(staffPath, s.owner().token(), body("email", uniqEmail("x"), "password", "12345678", "displayName", "lucky@mail.com", "role", "employee"));
    assertThat(bad.status()).isEqualTo(400);
    assertThat(bad.<String>get("message")).contains("can't be an email");

    String email = uniqEmail("cashier");
    Res created = post(staffPath, s.owner().token(), body("email", email, "password", "cashier-pass-1", "displayName", "Sipho", "role", "employee", "phone", "0821234567"));
    assertThat(created.status()).isEqualTo(201);
    assertThat(post(staffPath, s.owner().token(), body("email", email, "password", "cashier-pass-1", "displayName", "Again", "role", "employee")).code()).isEqualTo("already-exists");

    Res list = get(staffPath, s.owner().token());
    assertThat(list.list()).extracting(m -> m.get("displayName")).contains("Thandi", "Sipho");

    // the cashier signs in, sees their shop, but can't manage staff
    Res login = post("/api/auth/login", null, body("email", email.toUpperCase(), "password", "cashier-pass-1"));
    assertThat(login.status()).isEqualTo(200);
    assertThat(login.<List<Map<String, Object>>>get("memberships")).singleElement().satisfies(m -> assertThat(m.get("role")).isEqualTo("employee"));
    Res denied = get(staffPath, login.get("accessToken"));
    assertThat(denied.status()).isEqualTo(403);
    assertThat(denied.code()).isEqualTo("permission-denied");
    // ...and can't add a shop
    assertThat(post("/api/businesses", login.get("accessToken"), body("businessName", "Mine", "displayName", "Sipho")).code()).isEqualTo("permission-denied");

    assertThat(db.sql("select count(*) from docs where business_id = :b and collection = 'auditLogs'").param("b", s.businessId()).query(Integer.class).single()).isGreaterThanOrEqualTo(2);
  }

  @Test
  void wrongPasswordAndUnknownEmailLookTheSame() {
    TestShop s = newShop();
    String email = db.sql("select email from users u join businesses b on b.owner_uid = u.id where b.id = :b").param("b", s.businessId()).query(String.class).single();
    Res wrong = post("/api/auth/login", null, body("email", email, "password", "nope-nope-nope"));
    Res unknown = post("/api/auth/login", null, body("email", uniqEmail("nobody"), "password", "nope-nope-nope"));
    assertThat(wrong.status()).isEqualTo(401);
    assertThat(unknown.status()).isEqualTo(401);
    assertThat(wrong.body()).isEqualTo(unknown.body());
    assertThat(get("/api/me", null).status()).isEqualTo(401);
    assertThat(get("/api/me", "not-a-token").status()).isEqualTo(401);
  }

  @Test
  void refreshTokensRotateAndReuseEndsEverySession() {
    Res signup = post("/api/auth/signup", null, body("email", uniqEmail("rot"), "password", "rotate-pass-1", "displayName", "Rot"));
    String first = signup.get("refreshToken");
    Res next = post("/api/auth/refresh", null, body("refreshToken", first));
    assertThat(next.status()).isEqualTo(200);
    String second = next.get("refreshToken");
    assertThat(second).isNotEqualTo(first);

    // the old token comes back (copied?): refused, and the new one stops working too
    assertThat(post("/api/auth/refresh", null, body("refreshToken", first)).status()).isEqualTo(401);
    assertThat(post("/api/auth/refresh", null, body("refreshToken", second)).status()).isEqualTo(401);

    // sign-out revokes
    Res fresh = post("/api/auth/login", null, body("email", signup.<String>get("user.email"), "password", "rotate-pass-1"));
    post("/api/auth/logout", null, body("refreshToken", fresh.get("refreshToken")));
    assertThat(post("/api/auth/refresh", null, body("refreshToken", fresh.get("refreshToken"))).status()).isEqualTo(401);
  }

  @Test
  void deactivatingStopsAWorkerImmediately() {
    TestShop s = newShop();
    String staffPath = "/api/businesses/" + s.businessId() + "/staff";
    String email = uniqEmail("chef");
    String uid = post(staffPath, s.owner().token(), body("email", email, "password", "chef-pass-123", "displayName", "Mandla", "role", "kitchen")).get("uid");
    Res login = post("/api/auth/login", null, body("email", email, "password", "chef-pass-123"));
    String access = login.get("accessToken");
    assertThat(get("/api/me", access).status()).isEqualTo(200);

    String ownerUid = db.sql("select owner_uid from businesses where id = :b").param("b", s.businessId()).query(String.class).single();
    assertThat(patch(staffPath + "/" + ownerUid, s.owner().token(), body("active", false)).code()).isEqualTo("failed-precondition");
    assertThat(patch(staffPath + "/" + uid, s.owner().token(), body("active", false)).status()).isEqualTo(200);

    // their still-valid access token no longer opens the shop, and they can't sign in or refresh
    assertThat(get(staffPath, access).<String>get("message")).isEqualTo("Your account has been deactivated");
    assertThat(post("/api/auth/login", null, body("email", email, "password", "chef-pass-123")).code()).isEqualTo("user-disabled");
    assertThat(post("/api/auth/refresh", null, body("refreshToken", login.get("refreshToken"))).status()).isEqualTo(401);

    // reactivate, rename and set a new password
    assertThat(patch(staffPath + "/" + uid, s.owner().token(), body("active", true, "displayName", "Chef Mandla", "password", "new-chef-pass")).status()).isEqualTo(200);
    assertThat(post("/api/auth/login", null, body("email", email, "password", "chef-pass-123")).status()).isEqualTo(401);
    Res again = post("/api/auth/login", null, body("email", email, "password", "new-chef-pass"));
    assertThat(again.status()).isEqualTo(200);
    assertThat(again.<String>get("user.displayName")).isEqualTo("Chef Mandla");
  }

  @Test
  void passwordResetByEmail() {
    String email = uniqEmail("reset");
    post("/api/auth/signup", null, body("email", email, "password", "old-pass-123", "displayName", "Reset"));
    assertThat(post("/api/auth/password-reset", null, body("email", email)).status()).isEqualTo(200);
    assertThat(post("/api/auth/password-reset", null, body("email", uniqEmail("nobody"))).status()).isEqualTo(200); // no hint
    assertThat(mail.sent).hasSize(1);
    Matcher m = Pattern.compile("token=([A-Za-z0-9_-]+)").matcher(mail.sent.get(0)[2]);
    assertThat(m.find()).isTrue();
    String token = m.group(1);

    assertThat(post("/api/auth/password-reset/confirm", null, body("token", token, "newPassword", "short")).code()).isEqualTo("invalid-argument");
    assertThat(post("/api/auth/password-reset/confirm", null, body("token", token, "newPassword", "brand-new-pass")).status()).isEqualTo(200);
    assertThat(post("/api/auth/password-reset/confirm", null, body("token", token, "newPassword", "again-new-pass")).status()).isEqualTo(400); // once only
    assertThat(post("/api/auth/login", null, body("email", email, "password", "old-pass-123")).status()).isEqualTo(401);
    assertThat(post("/api/auth/login", null, body("email", email, "password", "brand-new-pass")).status()).isEqualTo(200);
  }

  @Test
  void passwordsImportedFromFirebaseKeepWorkingAndAreUpgraded() {
    String uid = "imported" + UUID.randomUUID().toString().replace("-", "").substring(0, 20);
    String email = uniqEmail("imported");
    // Firebase's published example user (see FirebaseScryptTest)
    db.sql("insert into users (id, email, display_name, password_algo, password_hash, password_salt) values (:id, :e, 'Lucky', 'firebase-scrypt', :h, :s)")
        .param("id", uid).param("e", email)
        .param("h", "lSrfV15cpx95/sZS2W9c9Kp6i/LVgQNDNC/qzrCnh1SAyZvqmZqAjTdn3aoItz+VHjoZilo78198JAdRuid5lQ==")
        .param("s", "42xEC+ixf3L2lw==")
        .update();
    assertThat(post("/api/auth/login", null, body("email", email, "password", "wrong-password")).status()).isEqualTo(401);
    assertThat(post("/api/auth/login", null, body("email", email, "password", "user1password")).status()).isEqualTo(200);
    assertThat(db.sql("select password_algo from users where id = :id").param("id", uid).query(String.class).single()).isEqualTo("argon2id");
    assertThat(post("/api/auth/login", null, body("email", email, "password", "user1password")).status()).isEqualTo(200);
  }
}
