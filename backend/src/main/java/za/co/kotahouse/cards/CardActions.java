package za.co.kotahouse.cards;

import static za.co.kotahouse.domain.Domain.cents;
import static za.co.kotahouse.domain.Domain.map;
import static za.co.kotahouse.domain.Domain.str;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirements;
import io.swagger.v3.oas.annotations.tags.Tag;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;
import za.co.kotahouse.actions.Body;
import za.co.kotahouse.actions.Ctx;
import za.co.kotahouse.audit.AuditLog;
import za.co.kotahouse.auth.TokenService;
import za.co.kotahouse.common.ApiException;
import za.co.kotahouse.shop.Caller;
import za.co.kotahouse.store.Store;

/** Card machines of any provider: upload, live push (webhook) and matching. */
@RestController
@Tag(name = "Card machines")
public class CardActions {
  private final Ctx ctx;
  private final Store store;
  private final CardService cards;
  private final AuditLog audit;
  private final TransactionTemplate tx;
  private final String apiUrl;

  public CardActions(Ctx ctx, Store store, CardService cards, AuditLog audit, TransactionTemplate tx, @Value("${kotahouse.api-url:}") String apiUrl) {
    this.ctx = ctx;
    this.store = store;
    this.cards = cards;
    this.audit = audit;
    this.tx = tx;
    this.apiUrl = apiUrl;
  }

  @Operation(summary = "Import card-machine transactions", description = """
      Owner only. The app reads the provider's CSV export (any provider) and sends the rows: \
      {provider, rows: [{atMillis, amountCents, reference?, status?, last4?, terminal?}]}. \
      Sending the same rows again is harmless. Every open card sale is then matched.""")
  @PostMapping("/api/rpc/importCardTransactions")
  @Transactional
  public Map<String, Object> importCardTransactions(@AuthenticationPrincipal Jwt jwt, @RequestBody Map<String, Object> data) {
    Body d = Body.of(data);
    Caller owner = ctx.require(jwt, d, "owner");
    var r = cards.ingest(owner.businessId(), d.str("provider"), "upload", owner.uid(), d.objects("rows"));
    cards.alertUnexplained(owner.businessId(), "uploaded " + d.str("provider") + " file");
    audit.record(owner, "cards.imported", "cardTransactions", d.str("provider"), Map.of("added", r.added(), "duplicates", r.duplicates(), "matched", r.matched()));
    return Map.of("added", r.added(), "duplicates", r.duplicates(), "matched", r.matched(), "unmatched", r.unmatched());
  }

  @Operation(summary = "Match a card payment to a sale by hand, or undo a match", description = "Owner only. saleId null undoes the match. The amounts must agree.")
  @PostMapping("/api/rpc/matchCardTransaction")
  @Transactional
  public Map<String, Object> matchCardTransaction(@AuthenticationPrincipal Jwt jwt, @RequestBody Map<String, Object> data) {
    Body d = Body.of(data);
    Caller owner = ctx.require(jwt, d, "owner");
    String b = owner.businessId();
    var txn = store.getForUpdate(b, CardService.COLLECTION, d.str("transactionId")).orElseThrow(() -> ApiException.notFound("Card payment not found"));
    if (!d.has("saleId")) {
      cards.unlink(b, txn);
      audit.record(owner, "cards.unmatched", "cardTransactions", str(txn.get("id")), Map.of());
      return Map.of("ok", true);
    }
    if (txn.get("matchedSaleId") != null) throw ApiException.precondition("This payment is already matched – undo that first");
    var sale = store.getForUpdate(b, "sales", d.str("saleId")).orElseThrow(() -> ApiException.notFound("Sale not found"));
    Map<String, Object> pay = map(sale.get("payment"));
    if (pay.get("cardTxnId") != null) throw ApiException.precondition("That sale is already matched to another card payment");
    long card = cents(sale.get("totalCents")) - Math.min(cents(pay.get("cashCents")), cents(sale.get("totalCents")));
    if ("cash".equals(pay.get("method")) || card != cents(txn.get("amountCents"))) throw ApiException.invalid("The amounts differ – the card part of that sale isn't this payment");
    cards.link(b, txn, sale, owner.uid());
    audit.record(owner, "cards.matched", "cardTransactions", str(txn.get("id")), Map.of("saleId", sale.get("id"), "receiptNo", sale.get("receiptNo")));
    return Map.of("ok", true);
  }

  @Operation(summary = "Get or renew the live link for a card provider", description = """
      Owner only. Returns the address and secret a provider (or Zapier/Make) uses to send transactions as they happen. \
      renew: true makes a new secret; the old one stops working.""")
  @PostMapping("/api/rpc/cardWebhook")
  @Transactional
  public Map<String, Object> cardWebhook(@AuthenticationPrincipal Jwt jwt, @RequestBody Map<String, Object> data) {
    Body d = Body.of(data);
    Caller owner = ctx.require(jwt, d, "owner");
    String b = owner.businessId();
    var existing = store.get(b, "private", "cards");
    String token;
    if (existing.isEmpty() || d.bool("renew")) {
      token = TokenService.randomToken();
      store.set(b, "private", "cards", Map.of("token", token));
      audit.record(owner, existing.isEmpty() ? "cards.webhookCreated" : "cards.webhookRenewed", "cardTransactions", "webhook", Map.of());
    } else {
      token = str(existing.get().get("token"));
    }
    return Map.of("url", apiUrl + "/api/webhooks/cards/" + b, "header", "X-Card-Token", "token", token);
  }

  @Operation(summary = "Card payments pushed by a provider (live)", description = """
      Header X-Card-Token: the shop's secret from cardWebhook. Body: {provider, transactions: [{atMillis | at (ISO time), \
      amountCents | amount (rand), reference?, status?, last4?, terminal?}]}. Matching runs straight away.""")
  @SecurityRequirements
  @PostMapping("/api/webhooks/cards/{businessId}")
  public ResponseEntity<Map<String, Object>> push(@PathVariable String businessId, @RequestHeader(name = "X-Card-Token", required = false) String given,
      @RequestBody Map<String, Object> data) {
    if (!businessId.matches("^[A-Za-z0-9_-]{1,128}$")) return ResponseEntity.status(403).build();
    String expected = store.get(businessId, "private", "cards").map(c -> str(c.get("token"))).orElse(null);
    if (expected == null || given == null || !MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8), given.getBytes(StandardCharsets.UTF_8))) {
      return ResponseEntity.status(403).build();
    }
    Body d = Body.of(data);
    List<Map<String, Object>> rows = d.objects("transactions").stream().map(CardActions::normalise).toList();
    var r = tx.execute(t -> cards.ingest(businessId, d.str("provider"), "webhook", "webhook", rows));
    return ResponseEntity.ok(Map.of("added", r.added(), "duplicates", r.duplicates(), "matched", r.matched()));
  }

  /** Providers and Zapier send times as ISO text and amounts in rand: accept both. */
  static Map<String, Object> normalise(Map<String, Object> r) {
    Map<String, Object> out = new java.util.LinkedHashMap<>(r);
    if (!(out.get("atMillis") instanceof Number) && out.get("at") != null) {
      try {
        out.put("atMillis", java.time.OffsetDateTime.parse(out.get("at").toString()).toInstant().toEpochMilli());
      } catch (java.time.format.DateTimeParseException e) {
        try {
          out.put("atMillis", java.time.Instant.parse(out.get("at").toString()).toEpochMilli());
        } catch (java.time.format.DateTimeParseException e2) {
          throw ApiException.invalid("at must be an ISO time, e.g. 2026-11-24T14:05:00+02:00");
        }
      }
    }
    if (!(out.get("amountCents") instanceof Number) && out.get("amount") != null) {
      try {
        out.put("amountCents", Math.round(Double.parseDouble(out.get("amount").toString().replaceAll("[^0-9.\\-]", "")) * 100));
      } catch (NumberFormatException e) {
        throw ApiException.invalid("amount must be a number in rand, e.g. 45.50");
      }
    }
    return out;
  }
}
