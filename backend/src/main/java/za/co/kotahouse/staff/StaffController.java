package za.co.kotahouse.staff;

import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import za.co.kotahouse.shop.ShopAccess;

@RestController
@RequestMapping("/api/businesses/{businessId}/staff")
public class StaffController {
  private final StaffService staff;
  private final ShopAccess access;

  public StaffController(StaffService staff, ShopAccess access) {
    this.staff = staff;
    this.access = access;
  }

  @GetMapping
  List<StaffService.Employee> list(@AuthenticationPrincipal Jwt jwt, @PathVariable String businessId) {
    return staff.list(access.require(jwt, businessId, "owner"));
  }

  @PostMapping
  @ResponseStatus(HttpStatus.CREATED)
  Map<String, String> create(@AuthenticationPrincipal Jwt jwt, @PathVariable String businessId, @RequestBody StaffService.NewEmployee r) {
    return Map.of("uid", staff.create(access.require(jwt, businessId, "owner"), r));
  }

  @PatchMapping("/{uid}")
  Map<String, Boolean> update(@AuthenticationPrincipal Jwt jwt, @PathVariable String businessId, @PathVariable String uid, @RequestBody StaffService.Changes r) {
    staff.update(access.require(jwt, businessId, "owner"), uid, r);
    return Map.of("ok", true);
  }
}
