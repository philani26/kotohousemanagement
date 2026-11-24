package za.co.kotahouse;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.client.RestClient;
import org.testcontainers.postgresql.PostgreSQLContainer;
import za.co.kotahouse.auth.Mailer;

/** Runs the real app on a random port against a real PostgreSQL in Docker. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {
        // Firebase's published scrypt example parameters, for the imported-password test
        "kotahouse.firebase.signer-key=jxspr8Ki0RYycVU8zykbdLGjFQ3McFUH0uiiTvC8pVMXAn210wjLNmdZJzxUECKbm0QsEmYUSDzZvpjeJ9WmXA==",
        "kotahouse.jwt-secret=dGVzdC1vbmx5LWtleS10ZXN0LW9ubHkta2V5LTMyYnl0ZXMhIQ==",
        // no calls to Yoco or Meta from tests; the scheduled check is run by its own test
        "kotahouse.yoco.dry-run=true",
        "kotahouse.whatsapp.allow-unsigned=true",
        "kotahouse.monitor-initial-delay=24h"
    })
@Import(ApiTestBase.TestMail.class)
public abstract class ApiTestBase {
  /** One PostgreSQL for the whole test run: Spring re-uses the app between test classes, so the database must outlive each class. */
  @ServiceConnection
  static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer("postgres:17-alpine");

  static {
    POSTGRES.start();
  }

  @LocalServerPort
  protected int port;

  @Autowired
  protected JdbcClient db;

  @Autowired
  protected SentMail mail;

  protected RestClient http;

  @BeforeEach
  protected void client() {
    http = RestClient.builder().baseUrl("http://localhost:" + port).build();
    mail.sent.clear();
  }

  /** Response status and JSON body; never throws on 4xx/5xx so tests can assert on errors. */
  public record Res(int status, Map<String, Object> body, List<Map<String, Object>> list) {
    public String code() {
      return body == null ? null : (String) body.get("code");
    }

    @SuppressWarnings("unchecked")
    public <T> T get(String path) {
      Object cur = body;
      for (String k : path.split("\\.")) cur = ((Map<String, Object>) cur).get(k);
      return (T) cur;
    }
  }

  @SuppressWarnings("unchecked")
  protected Res call(HttpMethod method, String path, String token, Object body) {
    var req = http.method(method).uri(path).accept(MediaType.APPLICATION_JSON);
    if (token != null) req = req.header("Authorization", "Bearer " + token);
    if (body != null) req = req.contentType(MediaType.APPLICATION_JSON).body(body);
    return req.exchange((rq, rs) -> {
      byte[] bytes = rs.getBody().readAllBytes();
      Object parsed = bytes.length == 0 ? null : new tools.jackson.databind.json.JsonMapper().readValue(bytes, Object.class);
      return new Res(rs.getStatusCode().value(), parsed instanceof Map<?, ?> m ? (Map<String, Object>) m : null,
          parsed instanceof List<?> l ? (List<Map<String, Object>>) l : null);
    });
  }

  protected Res post(String path, String token, Object body) {
    return call(HttpMethod.POST, path, token, body);
  }

  protected Res get(String path, String token) {
    return call(HttpMethod.GET, path, token, null);
  }

  protected Res patch(String path, String token, Object body) {
    return call(HttpMethod.PATCH, path, token, body);
  }

  protected static String uniqEmail(String name) {
    return name + "-" + java.util.UUID.randomUUID().toString().substring(0, 8) + "@example.co.za";
  }

  protected static Map<String, Object> body(Object... kv) {
    Map<String, Object> m = new java.util.HashMap<>();
    for (int i = 0; i < kv.length; i += 2) m.put((String) kv[i], kv[i + 1]);
    return m;
  }

  /** A signed-in person of a test shop. */
  public record Person(String uid, String token) {}

  public record TestShop(String businessId, Person owner) {}

  /** Signs up an owner and opens a shop. */
  protected TestShop newShop() {
    Res signup = post("/api/auth/signup", null, body("email", uniqEmail("owner"), "password", "owner-pass-123", "displayName", "Thandi"));
    String token = signup.get("accessToken");
    Res shop = post("/api/businesses", token, body("businessName", "Test Kota", "displayName", "Thandi"));
    return new TestShop(shop.get("businessId"), new Person(signup.get("user.uid"), token));
  }

  /** Adds a staff login (role employee = cashier, or kitchen) and signs them in. */
  protected Person addStaff(TestShop shop, String role, String name) {
    String email = uniqEmail(role);
    Res created = post("/api/businesses/" + shop.businessId() + "/staff", shop.owner().token(),
        body("email", email, "password", "staff-pass-123", "displayName", name, "role", role));
    Res login = post("/api/auth/login", null, body("email", email, "password", "staff-pass-123"));
    return new Person(created.get("uid"), login.get("accessToken"));
  }

  /** Captures emails instead of logging them. */
  public static class SentMail implements Mailer {
    public final List<String[]> sent = new ArrayList<>();

    @Override
    public void send(String to, String subject, String text) {
      sent.add(new String[] {to, subject, text});
    }
  }

  @TestConfiguration
  static class TestMail {
    @Bean
    @Primary
    SentMail sentMail() {
      return new SentMail();
    }
  }
}
