package za.co.kotahouse.common;

import org.springframework.http.HttpStatus;

/**
 * An error the app shows to the person, with the same codes the Firebase
 * functions used (invalid-argument, permission-denied, …) so the app's error
 * handling keeps working.
 */
public class ApiException extends RuntimeException {
  private final HttpStatus status;
  private final String code;

  public ApiException(HttpStatus status, String code, String message) {
    super(message);
    this.status = status;
    this.code = code;
  }

  public HttpStatus status() {
    return status;
  }

  public String code() {
    return code;
  }

  public static ApiException invalid(String message) {
    return new ApiException(HttpStatus.BAD_REQUEST, "invalid-argument", message);
  }

  public static ApiException precondition(String message) {
    return new ApiException(HttpStatus.CONFLICT, "failed-precondition", message);
  }

  public static ApiException denied(String message) {
    return new ApiException(HttpStatus.FORBIDDEN, "permission-denied", message);
  }

  public static ApiException unauthenticated(String message) {
    return new ApiException(HttpStatus.UNAUTHORIZED, "unauthenticated", message);
  }

  public static ApiException notFound(String message) {
    return new ApiException(HttpStatus.NOT_FOUND, "not-found", message);
  }

  public static ApiException exists(String message) {
    return new ApiException(HttpStatus.CONFLICT, "already-exists", message);
  }
}
