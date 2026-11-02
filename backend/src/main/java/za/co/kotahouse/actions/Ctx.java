package za.co.kotahouse.actions;

import java.util.Map;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.stereotype.Component;
import za.co.kotahouse.common.ApiException;
import za.co.kotahouse.settings.Settings;
import za.co.kotahouse.settings.SettingsService;
import za.co.kotahouse.shop.Caller;
import za.co.kotahouse.shop.ShopAccess;
import za.co.kotahouse.store.Store;
import za.co.kotahouse.store.Ts;

/**
 * Who is calling an action, in which shop (port of requireCaller in common.ts).
 * The app sends businessId and deviceId in every action body, as it did to the
 * callables. Besides the role, staff must have checked in at the shop when the
 * owner switched the work-site check on, and use an approved device when the
 * owner locked work to approved devices. Owners are exempt from both.
 */
@Component
public class Ctx {
  private final ShopAccess access;
  private final Store store;
  private final SettingsService settings;

  public Ctx(ShopAccess access, Store store, SettingsService settings) {
    this.access = access;
    this.store = store;
    this.settings = settings;
  }

  public record Options(boolean skipSiteCheck, boolean skipDeviceCheck) {
    public static final Options NONE = new Options(false, false);
    public static final Options SKIP_BOTH = new Options(true, true);
  }

  /** Default roles: owner and cashier. */
  public Caller require(Jwt jwt, Body body) {
    return require(jwt, body, Options.NONE, "owner", "employee");
  }

  public Caller require(Jwt jwt, Body body, String... roles) {
    return require(jwt, body, Options.NONE, roles);
  }

  public Caller require(Jwt jwt, Body body, Options opts, String... roles) {
    String businessId = businessId(jwt, body);
    Caller c = access.require(jwt, businessId, roles);
    if (!c.isOwner() && (!opts.skipSiteCheck() || !opts.skipDeviceCheck())) {
      Settings s = settings.read(businessId);
      Map<String, Object> me = store.get(businessId, Store.EMPLOYEES, c.uid()).orElse(Map.of());
      if (!opts.skipSiteCheck() && s.flag("geofence", "enabled")) {
        Long until = Ts.millis(me.get("siteCheckUntil"));
        if (until == null || until < System.currentTimeMillis()) {
          throw ApiException.denied("Check in at the shop first: open the app at work and allow your location");
        }
      }
      if (!opts.skipDeviceCheck() && s.flag("devices", "lockToApproved")) {
        String deviceId = body.str("deviceId");
        Object status = deviceId.isEmpty() ? null : store.get(businessId, "devices", deviceId).map(d -> d.get("status")).orElse(null);
        if (!"approved".equals(status)) throw ApiException.denied("This phone is not an approved shop device. Ask the owner to approve it.");
      }
    }
    return c;
  }

  /** The shop the app is working in; without one, the person's first shop. */
  private String businessId(Jwt jwt, Body body) {
    String b = body.str("businessId");
    if (!b.isEmpty()) return b;
    var ms = access.memberships(jwt.getSubject());
    if (ms.isEmpty()) throw ApiException.denied("Your account is not linked to this shop");
    return ms.get(0).businessId();
  }
}
