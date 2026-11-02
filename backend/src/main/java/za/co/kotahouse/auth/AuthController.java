package za.co.kotahouse.auth;

import java.util.Map;
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

  @PostMapping("/auth/login")
  AuthService.Session login(@RequestBody LoginRequest r) {
    return auth.login(r.email(), r.password());
  }

  @PostMapping("/auth/signup")
  @ResponseStatus(HttpStatus.CREATED)
  AuthService.Session signup(@RequestBody SignupRequest r) {
    return auth.signup(r.email(), r.password(), r.displayName());
  }

  @PostMapping("/auth/refresh")
  AuthService.Session refresh(@RequestBody RefreshRequest r) {
    return auth.refresh(r.refreshToken());
  }

  @PostMapping("/auth/logout")
  Map<String, Boolean> logout(@RequestBody RefreshRequest r) {
    auth.logout(r.refreshToken());
    return Map.of("ok", true);
  }

  @PostMapping("/auth/password-reset")
  Map<String, Boolean> requestReset(@RequestBody ResetRequest r) {
    auth.requestPasswordReset(r.email());
    return Map.of("ok", true);
  }

  @PostMapping("/auth/password-reset/confirm")
  Map<String, Boolean> confirmReset(@RequestBody ResetConfirm r) {
    auth.confirmPasswordReset(r.token(), r.newPassword());
    return Map.of("ok", true);
  }

  /** The signed-in person, their shops, and a fresh Firebase token while the bridge is on. */
  @GetMapping("/me")
  AuthService.Session me(@AuthenticationPrincipal Jwt jwt) {
    return auth.me(jwt.getSubject());
  }
}
