package za.co.kotahouse.shop;

import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ShopController {
  private final ShopService shops;

  public ShopController(ShopService shops) {
    this.shops = shops;
  }

  public record CreateShop(String businessName, String displayName) {}

  @PostMapping("/api/businesses")
  @ResponseStatus(HttpStatus.CREATED)
  Map<String, String> create(@AuthenticationPrincipal Jwt jwt, @RequestBody CreateShop r) {
    return Map.of("businessId", shops.create(jwt.getSubject(), r.businessName(), r.displayName()));
  }
}
