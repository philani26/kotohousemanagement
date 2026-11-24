package za.co.kotahouse.actions;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirements;
import io.swagger.v3.oas.annotations.tags.Tag;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

/**
 * Runs the 15-minute checks on request. On Cloud Run the server only gets CPU
 * while handling requests, so Cloud Scheduler calls this instead of relying on
 * the in-process timer. Protected by MONITOR_TOKEN; off when that is not set.
 */
@RestController
@Tag(name = "System")
public class MonitorController {
  private final MonitorJob job;
  private final String token;

  public MonitorController(MonitorJob job, @Value("${kotahouse.monitor-token:}") String token) {
    this.job = job;
    this.token = token;
  }

  @Operation(summary = "Run the 15-minute checks now (called by Cloud Scheduler)")
  @SecurityRequirements
  @PostMapping("/api/internal/monitor")
  public ResponseEntity<String> run(@RequestHeader(name = "X-Monitor-Token", required = false) String given) {
    boolean ok = !token.isEmpty() && given != null
        && MessageDigest.isEqual(token.getBytes(StandardCharsets.UTF_8), given.getBytes(StandardCharsets.UTF_8));
    if (!ok) return ResponseEntity.status(403).body("Forbidden");
    job.run();
    return ResponseEntity.ok("ok");
  }
}
