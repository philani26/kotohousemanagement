package za.co.kotahouse.config;

import java.io.IOException;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import tools.jackson.databind.json.JsonMapper;
import za.co.kotahouse.auth.Mailer;
import za.co.kotahouse.bridge.AdminFirebaseBridge;
import za.co.kotahouse.bridge.FirebaseBridge;

@Configuration
public class BridgeConfig {

  @Bean
  FirebaseBridge firebaseBridge(AppProperties props, JsonMapper json) throws IOException {
    AppProperties.Firebase f = props.firebase();
    if (!f.enabled()) return new FirebaseBridge.Off();
    if (f.projectId() == null || f.projectId().isBlank()) throw new IllegalStateException("FIREBASE_PROJECT_ID is required when FIREBASE_BRIDGE=true");
    return new AdminFirebaseBridge(f.projectId(), json);
  }

  @Bean
  Mailer mailer() {
    return new Mailer.LogMailer();
  }
}
