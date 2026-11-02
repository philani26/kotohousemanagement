package za.co.kotahouse.config;

import io.swagger.v3.oas.models.Components;
import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Info;
import io.swagger.v3.oas.models.security.SecurityRequirement;
import io.swagger.v3.oas.models.security.SecurityScheme;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Swagger / OpenAPI description of the API. To try protected endpoints in the
 * Swagger UI: call POST /api/auth/login, copy accessToken, click Authorize.
 */
@Configuration
public class OpenApiConfig {
  static final String BEARER = "bearer";

  @Bean
  OpenAPI kotaHouseApi() {
    return new OpenAPI()
        .info(new Info()
            .title("Kota House API")
            .version("v1")
            .description("""
                Backend of the Kota House management system.

                **Signing in:** call `POST /api/auth/login`, copy `accessToken` from the response, \
                click **Authorize** and paste it. Access tokens last 15 minutes; use `POST /api/auth/refresh` for a new one.

                **Errors** are `{"code": "...", "message": "..."}`, e.g. `invalid-argument`, `permission-denied`, `not-found`.

                **Money** is always integer cents (ZAR): `4550` = R45,50."""))
        .components(new Components().addSecuritySchemes(BEARER,
            new SecurityScheme().type(SecurityScheme.Type.HTTP).scheme("bearer").bearerFormat("JWT")
                .description("Access token from POST /api/auth/login")))
        .addSecurityItem(new SecurityRequirement().addList(BEARER));
  }
}
