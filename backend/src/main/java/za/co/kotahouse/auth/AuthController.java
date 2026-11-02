package za.co.kotahouse.auth;

import java.util.Map;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirements;
import io.swagger.v3.oas.annotations.tags.Tag;

import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api")
@Tag(name = "Sign-in", description = "Logins, tokens and password reset")
public class AuthController {
  private final AuthService auth;

  public AuthController(AuthService auth) {
    this.auth = auth;
  }

  public record LoginRequest(String email, String password) {}

  public record SignupRequest(String email, String password, String displayName) {}

  public record RefreshRequest(String refreshToken) {}

  public record ResetRequest(String email) {}

  public record ResetConfirm(String token, String newPassword) {}

  @Operation(summary = "Sign in", description = "Returns an access token (15 min), a refresh token (30 days), the person's shops and a Firebase token while the bridge is on.")
  @SecurityRequirements
  @PostMapping("/auth/login")
  AuthService.Session login(@RequestBody LoginRequest r) {
    return auth.login(r.email(), r.password());
  }

  @Operation(summary = "Sign up as a new owner", description = "Creates the login only; create the first shop next with POST /api/businesses.")
  @SecurityRequirements
  @PostMapping("/auth/signup")
  @ResponseStatus(HttpStatus.CREATED)
  AuthService.Session signup(@RequestBody SignupRequest r) {
    return auth.signup(r.email(), r.password(), r.displayName());
  }

  @Operation(summary = "Swap a refresh token for new tokens", description = "The refresh token is rotated: the old one stops working. Re-using an old one ends every session of that person.")
  @SecurityRequirements
  @PostMapping("/auth/refresh")
  AuthService.Session refresh(@RequestBody RefreshRequest r) {
    return auth.refresh(r.refreshToken());
  }

  @Operation(summary = "Sign out", description = "Revokes the refresh token.")
  @SecurityRequirements
  @PostMapping("/auth/logout")
  Map<String, Boolean> logout(@RequestBody RefreshRequest r) {
    auth.logout(r.refreshToken());
    return Map.of("ok", true);
  }

  @Operation(summary = "Email a password-reset link", description = "Always answers ok, so nobody can find out which emails have logins.")
  @SecurityRequirements
  @PostMapping("/auth/password-reset")
  Map<String, Boolean> requestReset(@RequestBody ResetRequest r) {
    auth.requestPasswordReset(r.email());
    return Map.of("ok", true);
  }

  @Operation(summary = "Set a new password with the emailed link's token", description = "Signs the person out everywhere.")
  @SecurityRequirements
  @PostMapping("/auth/password-reset/confirm")
  Map<String, Boolean> confirmReset(@RequestBody ResetConfirm r) {
    auth.confirmPasswordReset(r.token(), r.newPassword());
    return Map.of("ok", true);
  }

  /** The signed-in person, their shops, and a fresh Firebase token while the bridge is on. */
  @Operation(summary = "The signed-in person and their shops")
  @GetMapping("/me")
  AuthService.Session me(@AuthenticationPrincipal Jwt jwt) {
    return auth.me(jwt.getSubject());
  }
}
