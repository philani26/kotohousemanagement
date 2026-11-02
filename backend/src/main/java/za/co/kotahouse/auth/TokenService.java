package za.co.kotahouse.auth;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.Base64;
import java.util.UUID;
import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.JwsHeader;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.oauth2.jwt.NimbusJwtEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import za.co.kotahouse.common.ApiException;
import za.co.kotahouse.config.AppProperties;

/**
 * Access tokens: short-lived HS256 JWTs carrying only the user id (roles are
 * read from the database on every request, so deactivation is immediate).
 * Refresh tokens: random, rotated on every use, stored as SHA-256 only.
 * Re-using an already-rotated refresh token revokes all of that user's sessions.
 */
@Service
public class TokenService {
  private static final Logger log = LoggerFactory.getLogger(TokenService.class);
  private static final SecureRandom RANDOM = new SecureRandom();
  static final String ISSUER = "kotahouse";

  private final AppProperties props;
  private final JdbcClient db;
  private final SecretKey key;
  private final NimbusJwtEncoder encoder;

  public TokenService(AppProperties props, JdbcClient db) {
    this.props = props;
    this.db = db;
    byte[] secret;
    if (props.jwtSecret() == null || props.jwtSecret().isBlank()) {
      log.warn("JWT_SECRET is not set: using a random key – everyone is signed out when the server restarts. Set it in every real environment.");
      secret = randomBytes(32);
    } else {
      secret = Base64.getDecoder().decode(props.jwtSecret());
      if (secret.length < 32) throw new IllegalStateException("JWT_SECRET must be at least 32 bytes (base64)");
    }
    this.key = new SecretKeySpec(secret, "HmacSHA256");
    this.encoder = NimbusJwtEncoder.withSecretKey(key).algorithm(MacAlgorithm.HS256).build();
  }

  public JwtDecoder decoder() {
    return NimbusJwtDecoder.withSecretKey(key).macAlgorithm(MacAlgorithm.HS256).build();
  }

  public record Tokens(String accessToken, String refreshToken, long expiresInSeconds) {}

  public String accessToken(String uid) {
    Instant now = Instant.now();
    JwtClaimsSet claims = JwtClaimsSet.builder()
        .issuer(ISSUER)
        .subject(uid)
        .issuedAt(now)
        .expiresAt(now.plus(props.accessTokenTtl()))
        .id(UUID.randomUUID().toString())
        .build();
    return encoder.encode(JwtEncoderParameters.from(JwsHeader.with(MacAlgorithm.HS256).build(), claims)).getTokenValue();
  }

  @Transactional
  public Tokens issue(String uid) {
    String refresh = newRefreshToken(uid, null);
    return new Tokens(accessToken(uid), refresh, props.accessTokenTtl().toSeconds());
  }

  /**
   * Swaps a refresh token for a new pair. Returns the user id.
   * Revocations must be saved even though the request then fails, so the error does not roll back.
   */
  @Transactional(noRollbackFor = ApiException.class)
  public RotateResult rotate(String refreshToken) {
    byte[] hash = sha256(refreshToken);
    var row = db.sql("select id, user_id, expires_at, revoked_at from refresh_tokens where token_hash = :h for update")
        .param("h", hash)
        .query((rs, i) -> new Object[] {rs.getObject("id", UUID.class), rs.getString("user_id"), rs.getTimestamp("expires_at").toInstant(), rs.getTimestamp("revoked_at")})
        .optional()
        .orElseThrow(() -> ApiException.unauthenticated("Please sign in again"));
    UUID id = (UUID) row[0];
    String uid = (String) row[1];
    if (row[3] != null) {
      // A rotated token came back: someone may have copied it. End every session of this user.
      revokeAll(uid);
      log.warn("Refresh token re-used for user {} – all sessions revoked", uid);
      throw ApiException.unauthenticated("Please sign in again");
    }
    if (((Instant) row[2]).isBefore(Instant.now())) throw ApiException.unauthenticated("Please sign in again");
    String next = newRefreshToken(uid, id);
    return new RotateResult(uid, new Tokens(accessToken(uid), next, props.accessTokenTtl().toSeconds()));
  }

  public record RotateResult(String uid, Tokens tokens) {}

  public void revoke(String refreshToken) {
    db.sql("update refresh_tokens set revoked_at = now() where token_hash = :h and revoked_at is null").param("h", sha256(refreshToken)).update();
  }

  public void revokeAll(String uid) {
    db.sql("update refresh_tokens set revoked_at = now() where user_id = :u and revoked_at is null").param("u", uid).update();
  }

  private String newRefreshToken(String uid, UUID replacing) {
    String token = base64Url(randomBytes(32));
    UUID id = UUID.randomUUID();
    db.sql("insert into refresh_tokens (id, user_id, token_hash, expires_at) values (:id, :u, :h, :exp)")
        .param("id", id)
        .param("u", uid)
        .param("h", sha256(token))
        .param("exp", java.sql.Timestamp.from(Instant.now().plus(props.refreshTokenTtl())))
        .update();
    if (replacing != null) {
      db.sql("update refresh_tokens set revoked_at = now(), replaced_by = :n where id = :id").param("n", id).param("id", replacing).update();
    }
    return token;
  }

  /** HMAC of a purpose and some data, for short signed links (e.g. viewing a receipt photo). */
  public String sign(String purpose, String data) {
    try {
      javax.crypto.Mac mac = javax.crypto.Mac.getInstance("HmacSHA256");
      mac.init(key);
      return base64Url(mac.doFinal((purpose + "|" + data).getBytes(StandardCharsets.UTF_8)));
    } catch (java.security.GeneralSecurityException e) {
      throw new IllegalStateException(e);
    }
  }

  public static String randomToken() {
    return base64Url(randomBytes(32));
  }

  static byte[] randomBytes(int n) {
    byte[] b = new byte[n];
    RANDOM.nextBytes(b);
    return b;
  }

  static String base64Url(byte[] b) {
    return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
  }

  public static byte[] sha256(String s) {
    try {
      return MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException(e);
    }
  }
}
