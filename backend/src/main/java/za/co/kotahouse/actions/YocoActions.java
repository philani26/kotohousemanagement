package za.co.kotahouse.actions;

import static za.co.kotahouse.domain.Domain.cents;
import static za.co.kotahouse.domain.Domain.str;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirements;
import io.swagger.v3.oas.annotations.tags.Tag;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;
import za.co.kotahouse.audit.AuditLog;
import za.co.kotahouse.common.ApiException;
import za.co.kotahouse.domain.Domain;
import za.co.kotahouse.domain.Yoco;
import za.co.kotahouse.settings.SettingsService;
import za.co.kotahouse.shop.Caller;
import za.co.kotahouse.store.Query;
import za.co.kotahouse.store.Store;

/**
 * Card payments on the customer's phone through Yoco's Checkout API (port of yoco.ts).
 * The owner's secret key and the webhook secret are kept in the shop's
 * "private" records, which no app user can read. In dry-run (local/tests) no
 * call goes to Yoco: checkouts get a fake link and the webhook secret is fixed.
 */
@RestController
@Tag(name = "Yoco card payments")
public class YocoActions {
  private static final Logger log = LoggerFactory.getLogger(YocoActions.class);
  public static final String DRY_RUN_WEBHOOK_SECRET = "whsec_" + Base64.getEncoder().encodeToString("kotahouse-emulator-yoco".getBytes(StandardCharsets.UTF_8));
  private static final SecureRandom RANDOM = new SecureRandom();

  private final Ctx ctx;
  private final Store store;
  private final AuditLog audit;
  private final JsonMapper json;
  private final org.springframework.transaction.support.TransactionTemplate tx;
  private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
  private final boolean dryRun;
  private final String apiUrl;

  public YocoActions(Ctx ctx, Store store, AuditLog audit, JsonMapper json, org.springframework.transaction.support.TransactionTemplate tx,
      @Value("${kotahouse.yoco.dry-run:false}") boolean dryRun, @Value("${kotahouse.api-url:}") String apiUrl) {
    this.ctx = ctx;
    this.store = store;
    this.audit = audit;
    this.json = json;
    this.tx = tx;
    this.dryRun = dryRun;
    this.apiUrl = apiUrl;
  }

  private Map<String, Object> keys(String b) {
    return store.get(b, "private", "yoco").orElse(null);
  }

  private Map<String, Object> callYoco(String secretKey, String method, String path, Object body, String idempotencyKey) {
    try {
      HttpRequest.Builder req = HttpRequest.newBuilder(URI.create(Yoco.API + path)).timeout(Duration.ofSeconds(20))
          .header("Authorization", "Bearer " + secretKey).header("Content-Type", "application/json");
      if (idempotencyKey != null) req.header("Idempotency-Key", idempotencyKey);
      req.method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)));
      HttpResponse<String> res = http.send(req.build(), HttpResponse.BodyHandlers.ofString());
      if (res.statusCode() >= 300) {
        log.warn("Yoco API error {} {}: {}", path, res.statusCode(), res.body().length() > 500 ? res.body().substring(0, 500) : res.body());
        String message = null;
        try {
          message = str(json.readValue(res.body(), new TypeReference<Map<String, Object>>() {}).get("message"));
        } catch (Exception ignored) {
          // not JSON
        }
        throw ApiException.precondition(res.statusCode() == 401 || res.statusCode() == 403 ? "Yoco did not accept the secret key"
            : "Yoco: " + (message != null ? message : "error " + res.statusCode()));
      }
      return res.body().isEmpty() ? Map.of() : json.readValue(res.body(), new TypeReference<Map<String, Object>>() {});
    } catch (java.io.IOException e) {
      throw ApiException.precondition("Could not reach Yoco – try again");
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw ApiException.precondition("Could not reach Yoco – try again");
    }
  }

  @Operation(summary = "Connect the shop's Yoco account", description = "Owner only. Checks the secret key and registers the payment webhook with Yoco.")
  @PostMapping("/api/rpc/connectYoco")
  @Transactional
  public Map<String, Object> connectYoco(@AuthenticationPrincipal Jwt jwt, @RequestBody Map<String, Object> data) {
    Body d = Body.of(data);
    Caller owner = ctx.require(jwt, d, "owner");
    String b = owner.businessId();
    String secretKey = d.str("secretKey").trim();
    String mode = Yoco.keyMode(secretKey);
    if (mode == null) throw ApiException.invalid("Paste the secret key from the Yoco portal – it starts with sk_live_ or sk_test_");
    Map<String, Object> old = keys(b);
    String webhookId;
    String webhookSecret;
    if (dryRun) {
      webhookId = "dry-run";
      webhookSecret = DRY_RUN_WEBHOOK_SECRET;
    } else {
      String url = apiUrl + "/api/webhooks/yoco?b=" + URLEncoder.encode(b, StandardCharsets.UTF_8);
      Map<String, Object> hook = callYoco(secretKey, "POST", "/webhooks", Map.of("name", ("Kota House " + b).substring(0, Math.min(60, ("Kota House " + b).length())), "url", url), null);
      webhookId = str(hook.get("id"));
      webhookSecret = str(hook.get("secret"));
      if (old != null && old.get("webhookId") != null) {
        try {
          callYoco(str(old.get("secretKey")), "DELETE", "/webhooks/" + old.get("webhookId"), null, null);
        } catch (Exception e) {
          log.warn("Could not remove old Yoco webhook", e);
        }
      }
    }
    store.set(b, "private", "yoco", Map.of("secretKey", secretKey, "webhookId", webhookId, "webhookSecret", webhookSecret, "mode", mode));
    store.merge(b, SettingsService.COLLECTION, SettingsService.DOC, Map.of("yoco", Map.of("enabled", true, "mode", mode)));
    audit.record(owner, "yoco.connected", "businessSettings", "yoco", Map.of("mode", mode));
    return Map.of("mode", mode);
  }

  @Operation(summary = "Disconnect Yoco", description = "Owner only.")
  @PostMapping("/api/rpc/disconnectYoco")
  @Transactional
  public Map<String, Object> disconnectYoco(@AuthenticationPrincipal Jwt jwt, @RequestBody Map<String, Object> data) {
    Body d = Body.of(data);
    Caller owner = ctx.require(jwt, d, "owner");
    String b = owner.businessId();
    Map<String, Object> old = keys(b);
    if (old != null && old.get("webhookId") != null && !dryRun) {
      try {
        callYoco(str(old.get("secretKey")), "DELETE", "/webhooks/" + old.get("webhookId"), null, null);
      } catch (Exception e) {
        log.warn("Could not remove Yoco webhook", e);
      }
    }
    if (old != null) store.delete(b, "private", "yoco");
    Map<String, Object> off = new LinkedHashMap<>();
    off.put("enabled", false);
    off.put("mode", null);
    store.merge(b, SettingsService.COLLECTION, SettingsService.DOC, Map.of("yoco", off));
    audit.record(owner, "yoco.disconnected", "businessSettings", "yoco", Map.of());
    return Map.of("ok", true);
  }

  @Operation(summary = "Start a card payment on the customer's phone", description = "The app shows the returned link as a QR code. R2 to R50,000.")
  @PostMapping("/api/rpc/createYocoCheckout")
  @Transactional
  public Map<String, Object> createYocoCheckout(@AuthenticationPrincipal Jwt jwt, @RequestBody Map<String, Object> data) {
    Body d = Body.of(data);
    Caller c = ctx.require(jwt, d);
    String b = c.businessId();
    String saleId = d.str("saleId");
    if (!saleId.matches("^[A-Za-z0-9_-]{16,64}$")) throw ApiException.invalid("Invalid sale id");
    long amount = d.optLong("amountCents") == null ? -1 : d.optLong("amountCents");
    if (amount < 200 || amount > 5_000_000) throw ApiException.invalid("Card payments on a phone must be between R2 and R50,000");
    Map<String, Object> k = keys(b);
    if (k == null) throw ApiException.precondition("Card payment on the phone is not set up – the owner connects Yoco under Settings");

    // Re-use an unpaid or paid checkout for the same sale and amount (e.g. the cashier tapped twice).
    for (Map<String, Object> ch : store.list(b, Query.of("yocoCheckouts").where("saleId", "==", saleId).build())) {
      if (cents(ch.get("amountCents")) == amount && !"failed".equals(ch.get("status")) && ch.get("usedBySale") == null) {
        return Map.of("checkoutId", ch.get("id"), "redirectUrl", ch.get("redirectUrl"));
      }
    }
    String id;
    String redirectUrl;
    if (dryRun) {
      byte[] r = new byte[8];
      RANDOM.nextBytes(r);
      id = "ch_emu_" + HexFormat.of().formatHex(r);
      redirectUrl = "https://pay.yoco.com/emulator/" + id;
    } else {
      Map<String, Object> checkout = callYoco(str(k.get("secretKey")), "POST", "/checkouts",
          Map.of("amount", amount, "currency", "ZAR", "externalId", saleId, "metadata", Map.of("businessId", b, "saleId", saleId)), saleId + "-" + amount);
      id = str(checkout.get("id"));
      redirectUrl = str(checkout.get("redirectUrl"));
    }
    Map<String, Object> doc = new LinkedHashMap<>();
    doc.put("saleId", saleId);
    doc.put("amountCents", amount);
    doc.put("status", "created");
    doc.put("redirectUrl", redirectUrl);
    doc.put("createdBy", c.uid());
    doc.put("createdAtMillis", System.currentTimeMillis());
    doc.put("mode", dryRun ? "emulator" : k.get("mode"));
    store.set(b, "yocoCheckouts", id, doc);
    return Map.of("checkoutId", id, "redirectUrl", redirectUrl);
  }

  @Operation(summary = "Yoco payment events (called by Yoco)", description = "Signed with the webhook secret; a payment counts only for the exact amount of its checkout.")
  @SecurityRequirements
  @PostMapping("/api/webhooks/yoco")
  public ResponseEntity<String> webhook(@RequestParam("b") String b, @RequestBody String raw,
      @RequestHeader(name = "webhook-id", required = false) String id,
      @RequestHeader(name = "webhook-timestamp", required = false) String timestamp,
      @RequestHeader(name = "webhook-signature", required = false) String signature) {
    Map<String, Object> k = b.matches("^[A-Za-z0-9_-]{1,128}$") ? keys(b) : null;
    if (k == null || !Yoco.signatureOk(str(k.get("webhookSecret")), id, timestamp, raw, signature, System.currentTimeMillis() / 1000)) {
      return ResponseEntity.status(403).body("Bad signature");
    }
    Map<String, Object> event = json.readValue(raw, new TypeReference<Map<String, Object>>() {});
    String type = str(event.get("type"));
    Map<String, Object> payload = Domain.map(event.get("payload"));
    String checkoutId = str(Domain.map(payload.get("metadata")).get("checkoutId"));
    if (("payment.succeeded".equals(type) || "payment.failed".equals(type)) && checkoutId != null && checkoutId.matches("^[A-Za-z0-9_-]{1,128}$")) {
      tx.executeWithoutResult(t -> {
        Map<String, Object> c = store.getForUpdate(b, "yocoCheckouts", checkoutId).orElse(null);
        if (c == null || "paid".equals(c.get("status"))) return; // not ours, or already handled (Yoco retries)
        if ("payment.failed".equals(type)) {
          store.update(b, "yocoCheckouts", checkoutId, Map.of("status", "failed"));
        } else if (!(payload.get("amount") instanceof Number n) || n.longValue() != cents(c.get("amountCents"))) {
          log.error("Yoco payment amount does not match the checkout {} {}: paid {}", b, checkoutId, payload.get("amount"));
          store.update(b, "yocoCheckouts", checkoutId, Map.of("status", "failed"));
        } else {
          store.update(b, "yocoCheckouts", checkoutId, Map.of("status", "paid", "paidAtMillis", System.currentTimeMillis(), "paymentId", String.valueOf(payload.getOrDefault("id", ""))));
        }
      });
    }
    return ResponseEntity.ok("ok");
  }
}
