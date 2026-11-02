package za.co.kotahouse;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

@SpringBootApplication
@ConfigurationPropertiesScan
public class KotaHouseApplication {
  public static void main(String[] args) {
    SpringApplication.run(KotaHouseApplication.class, args);
  }
}
