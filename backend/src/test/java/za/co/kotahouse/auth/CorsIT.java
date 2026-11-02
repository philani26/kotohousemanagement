package za.co.kotahouse.auth;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.web.server.LocalServerPort;
import za.co.kotahouse.ApiTestBase;

/** Only the app's own address may call the API from a browser. */
class CorsIT extends ApiTestBase {
  @LocalServerPort
  int localPort;

  private String allowedOrigin(String origin) throws Exception {
    HttpRequest req = HttpRequest.newBuilder(URI.create("http://localhost:" + localPort + "/api/auth/login"))
        .method("OPTIONS", HttpRequest.BodyPublishers.noBody())
        .header("Origin", origin)
        .header("Access-Control-Request-Method", "POST")
        .header("Access-Control-Request-Headers", "content-type")
        .build();
    HttpResponse<Void> res = HttpClient.newHttpClient().send(req, HttpResponse.BodyHandlers.discarding());
    return res.headers().firstValue("Access-Control-Allow-Origin").orElse(null);
  }

  @Test
  void onlyTheAppsOriginIsAllowed() throws Exception {
    assertThat(allowedOrigin("http://localhost:4200")).isEqualTo("http://localhost:4200");
    assertThat(allowedOrigin("https://evil.example")).isNull();
  }
}
