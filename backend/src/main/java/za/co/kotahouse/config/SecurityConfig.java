package za.co.kotahouse.config;

import java.util.List;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;
import za.co.kotahouse.auth.TokenService;

/** Stateless API: every request except sign-in carries a Bearer access token. */
@Configuration
public class SecurityConfig {

  @Bean
  SecurityFilterChain api(HttpSecurity http) throws Exception {
    http.csrf(c -> c.disable()) // no cookies: tokens travel in the Authorization header
        .cors(Customizer.withDefaults())
        .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        .authorizeHttpRequests(a -> a
            .requestMatchers(HttpMethod.OPTIONS, "/**").permitAll()
            .requestMatchers("/actuator/health/**", "/actuator/health").permitAll()
            // API documentation (only served when SWAGGER_ENABLED is on); every endpoint still needs a token
            // Called by Meta and Yoco; each checks its own signature instead of a login
            .requestMatchers("/api/webhooks/**").permitAll()
            // the scheduled checks, called by Cloud Scheduler with its own token
            .requestMatchers(HttpMethod.POST, "/api/internal/monitor").permitAll()
            // signed, five-minute links to a receipt photo (the browser opens them in a new tab)
            .requestMatchers(HttpMethod.GET, "/api/files/**").permitAll()
            .requestMatchers("/swagger-ui.html", "/swagger-ui/**", "/v3/api-docs", "/v3/api-docs/**").permitAll()
            .requestMatchers(HttpMethod.POST, "/api/auth/login", "/api/auth/refresh", "/api/auth/logout", "/api/auth/signup",
                "/api/auth/password-reset", "/api/auth/password-reset/confirm").permitAll()
            .anyRequest().authenticated())
        .oauth2ResourceServer(o -> o.jwt(Customizer.withDefaults()))
        .headers(h -> h.frameOptions(f -> f.deny()));
    return http.build();
  }

  @Bean
  JwtDecoder jwtDecoder(TokenService tokens) {
    return tokens.decoder();
  }

  @Bean
  CorsConfigurationSource corsConfigurationSource(AppProperties props) {
    CorsConfiguration c = new CorsConfiguration();
    c.setAllowedOrigins(props.corsOriginList());
    c.setAllowedMethods(List.of("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"));
    c.setAllowedHeaders(List.of("Authorization", "Content-Type", "X-Device-Id"));
    c.setMaxAge(3600L);
    UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
    source.registerCorsConfiguration("/api/**", c);
    return source;
  }
}
