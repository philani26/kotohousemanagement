package za.co.kotahouse.common;

import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/** Every error reaches the app as {"code": "...", "message": "..."}; unexpected ones never leak details. */
@RestControllerAdvice
public class ErrorHandler {
  private static final Logger log = LoggerFactory.getLogger(ErrorHandler.class);

  @ExceptionHandler(ApiException.class)
  ResponseEntity<Map<String, String>> api(ApiException e) {
    return ResponseEntity.status(e.status()).body(Map.of("code", e.code(), "message", e.getMessage()));
  }

  @ExceptionHandler(HttpMessageNotReadableException.class)
  ResponseEntity<Map<String, String>> unreadable(HttpMessageNotReadableException e) {
    return api(ApiException.invalid("The request could not be read"));
  }

  @ExceptionHandler(Exception.class)
  ResponseEntity<Map<String, String>> unexpected(Exception e) {
    log.error("Unhandled error", e);
    return ResponseEntity.internalServerError().body(Map.of("code", "internal", "message", "Something went wrong. Please try again."));
  }
}
