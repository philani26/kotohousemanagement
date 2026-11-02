package za.co.kotahouse;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import org.junit.jupiter.api.Test;

class SwaggerIT extends ApiTestBase {
  @Test
  void swaggerUiAndOpenApiAreServedWithoutSigningIn() {
    Res docs = get("/v3/api-docs", null);
    assertThat(docs.status()).isEqualTo(200);
    Map<String, Object> paths = docs.get("paths");
    assertThat(paths).containsKeys("/api/auth/login", "/api/me", "/api/businesses", "/api/businesses/{businessId}/staff");
    assertThat(docs.<Map<String, Object>>get("components.securitySchemes")).containsKey("bearer");
    // sign-in needs no token, everything else does
    assertThat(docs.<Object>get("paths./api/auth/login.post.security")).isEqualTo(java.util.List.of());

    Integer uiStatus = http.get().uri("/swagger-ui/index.html").exchange((rq, rs) -> rs.getStatusCode().value());
    assertThat(uiStatus).isEqualTo(200);
    // the docs don't open the API itself
    assertThat(get("/api/me", null).status()).isEqualTo(401);
  }
}
