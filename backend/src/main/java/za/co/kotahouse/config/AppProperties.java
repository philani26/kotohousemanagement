package za.co.kotahouse.config;

import java.time.Duration;
import java.util.Arrays;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties("kotahouse")
public record AppProperties(
    String jwtSecret,
    Duration accessTokenTtl,
    Duration refreshTokenTtl,
    String ownerEmails,
    String corsOrigins,
    String appUrl,
    Firebase firebase) {

  public record Firebase(boolean enabled, String projectId, String signerKey, String saltSeparator, int rounds, int memCost) {}

  /** Empty list = anyone signed in may create a shop. */
  public List<String> ownerEmailList() {
    return split(ownerEmails).stream().map(String::toLowerCase).toList();
  }

  public List<String> corsOriginList() {
    return split(corsOrigins);
  }

  private static List<String> split(String s) {
    return s == null ? List.of() : Arrays.stream(s.split(",")).map(String::trim).filter(x -> !x.isEmpty()).toList();
  }
}
