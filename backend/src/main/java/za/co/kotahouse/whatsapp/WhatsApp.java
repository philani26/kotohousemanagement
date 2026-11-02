package za.co.kotahouse.whatsapp;

import static za.co.kotahouse.domain.Domain.cents;
import static za.co.kotahouse.domain.Domain.str;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirements;
import io.swagger.v3.oas.annotations.tags.Tag;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.event.TransactionalEventListener;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.json.JsonMapper;
import za.co.kotahouse.actions.Body;
import za.co.kotahouse.actions.Ctx;
import za.co.kotahouse.actions.Effects;
import za.co.kotahouse.actions.Notifier;
import za.co.kotahouse.actions.OrderActions;
import za.co.kotahouse.audit.AuditLog;
import za.co.kotahouse.common.ApiException;
import za.co.kotahouse.common.Days;
import za.co.kotahouse.domain.Domain;
import za.co.kotahouse.domain.WhatsAppBot;
import za.co.kotahouse.settings.Settings;
import za.co.kotahouse.settings.SettingsService;
import za.co.kotahouse.shop.Caller;
import za.co.kotahouse.store.Op;
import za.co.kotahouse.store.Query;
import za.co.kotahouse.store.Store;

/**
 * WhatsApp ordering through the WhatsApp Business Platform (port of whatsapp.ts).
 * Settings: WHATSAPP_TOKEN, WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN.
 * Without a token every outgoing message is only logged ("dry-run").
 */
@RestController
@Tag(name = "WhatsApp")
public class WhatsApp {
  private static final Logger log = LoggerFactory.getLogger(WhatsApp.class);
  private static final String GRAPH = "https://graph.facebook.com/v21.0";
  /** global records: phoneNumberId → businessId */
  static final String NUMBERS = "whatsappNumbers";

  private final Store store;
  private final SettingsService settingsService;
  private final Notifier notifier;
  private final AuditLog audit;
  private final Ctx ctx;
  private final TransactionTemplate tx;
  private final JsonMapper json;
  private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
  private final String token;
  private final String appSecret;
  private final String verifyToken;
  private final boolean allowUnsigned;

  public WhatsApp(Store store, SettingsService settingsService, Notifier notifier, AuditLog audit, Ctx ctx, TransactionTemplate tx, JsonMapper json,
      @Value("${kotahouse.whatsapp.token:}") String token,
      @Value("${kotahouse.whatsapp.app-secret:}") String appSecret,
      @Value("${kotahouse.whatsapp.verify-token:}") String verifyToken,
      @Value("${kotahouse.whatsapp.allow-unsigned:false}") boolean allowUnsigned) {
    this.store = store;
    this.settingsService = settingsService;
    this.notifier = notifier;
    this.audit = audit;
    this.ctx = ctx;
    this.tx = tx;
    this.json = json;
    this.token = token;
    this.appSecret = appSecret;
    this.verifyToken = verifyToken;
    this.allowUnsigned = allowUnsigned;
  }

  /** WhatsApp orders are numbered W1, W2… so they never clash with till orders on the board. */
  static String waLabel(Object n) {
    return "W" + (n == null ? 0 : cents(n));
  }

  /** Sends a text (or logs it in dry-run mode) and keeps a copy in the shop's message log. Call outside transactions. */
  public void send(String businessId, String phoneNumberId, String to, String text) {
    String status = token.isEmpty() ? "dry-run" : "sent";
    String error = null;
    if (!token.isEmpty() && phoneNumberId != null && !phoneNumberId.isEmpty()) {
      try {
        String body = json.writeValueAsString(Map.of("messaging_product", "whatsapp", "to", to, "type", "text", "text", Map.of("body", text, "preview_url", false)));
        HttpResponse<String> res = http.send(HttpRequest.newBuilder(URI.create(GRAPH + "/" + phoneNumberId + "/messages"))
            .timeout(Duration.ofSeconds(15))
            .header("Authorization", "Bearer " + token).header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString());
        if (res.statusCode() >= 300) {
          status = "failed";
          error = res.body().length() > 500 ? res.body().substring(0, 500) : res.body();
        }
      } catch (Exception e) {
        status = "failed";
        error = String.valueOf(e);
        if (e instanceof InterruptedException) Thread.currentThread().interrupt();
      }
    }
    if ("failed".equals(status)) log.error("WhatsApp send failed for {}: {}", businessId, error);
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("direction", "out");
    m.put("waId", to);
    m.put("text", text);
    m.put("status", status);
    if (error != null) m.put("error", error);
    m.put("at", Op.serverTime());
    tx.executeWithoutResult(t -> store.set(businessId, "whatsappMessages", store.newId(), m));
  }

  /** Meta signs every webhook call with the app secret (X-Hub-Signature-256). */
  boolean signatureOk(String rawBody, String header) {
    if (appSecret.isEmpty()) return allowUnsigned; // fail closed in production
    if (rawBody == null || header == null || !header.startsWith("sha256=")) return false;
    try {
      Mac mac = Mac.getInstance("HmacSHA256");
      mac.init(new SecretKeySpec(appSecret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
      String expected = "sha256=" + HexFormat.of().formatHex(mac.doFinal(rawBody.getBytes(StandardCharsets.UTF_8)));
      return MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8), header.getBytes(StandardCharsets.UTF_8));
    } catch (Exception e) {
      return false;
    }
  }

  @Operation(summary = "Meta's webhook verification handshake")
  @SecurityRequirements
  @GetMapping("/api/webhooks/whatsapp")
  public ResponseEntity<String> verify(@RequestParam(name = "hub.mode", required = false) String mode,
      @RequestParam(name = "hub.verify_token", required = false) String vt,
      @RequestParam(name = "hub.challenge", required = false) String challenge) {
    boolean ok = "subscribe".equals(mode) && !verifyToken.isEmpty() && verifyToken.equals(vt);
    return ok ? ResponseEntity.ok(challenge == null ? "" : challenge) : ResponseEntity.status(403).body("Forbidden");
  }

  record Incoming(String phoneNumberId, String from, String name, String text, String messageId) {}

  @Operation(summary = "Incoming WhatsApp messages (called by Meta)")
  @SecurityRequirements
  @PostMapping("/api/webhooks/whatsapp")
  public ResponseEntity<String> receive(@RequestBody String raw, @RequestHeader(name = "X-Hub-Signature-256", required = false) String sig) {
    if (!signatureOk(raw, sig)) return ResponseEntity.status(403).body("Bad signature");
    try {
      Map<String, Object> payload = json.readValue(raw, new tools.jackson.core.type.TypeReference<Map<String, Object>>() {});
      for (Incoming m : readPayload(payload)) process(m);
    } catch (Exception e) {
      log.error("WhatsApp webhook failed", e);
    }
    // Always acknowledge, otherwise Meta keeps re-sending the same messages.
    return ResponseEntity.ok("ok");
  }

  @SuppressWarnings("unchecked")
  static List<Incoming> readPayload(Map<String, Object> body) {
    List<Incoming> out = new ArrayList<>();
    for (Object e : Domain.list(body.get("entry"))) {
      for (Map<String, Object> change : Domain.list(((Map<String, Object>) e).get("changes"))) {
        Map<String, Object> value = Domain.map(change.get("value"));
        String phoneNumberId = str(Domain.map(value.get("metadata")).get("phone_number_id"));
        List<Map<String, Object>> contacts = Domain.list(value.get("contacts"));
        for (Map<String, Object> m : Domain.list(value.get("messages"))) {
          String from = str(m.get("from"));
          Object text = Domain.map(m.get("text")).get("body");
          if (text == null) text = Domain.map(m.get("button")).get("text");
          if (text == null) text = Domain.map(Domain.map(m.get("interactive")).get("button_reply")).get("title");
          if (from == null || from.isEmpty() || phoneNumberId == null || phoneNumberId.isEmpty()) continue;
          String name = contacts.stream().filter(c -> from.equals(c.get("wa_id"))).map(c -> str(Domain.map(c.get("profile")).get("name"))).findFirst().orElse("");
          String t = text == null ? "" : text.toString();
          out.add(new Incoming(phoneNumberId, from, name == null ? "" : name, t.length() > 1000 ? t.substring(0, 1000) : t, str(m.get("id"))));
        }
      }
    }
    return out;
  }

  static boolean isOpenNow(Settings s, Instant now) {
    int hour = Days.localHour(now, s.timezone());
    Object days = s.data().get("tradingDays");
    boolean trading = days instanceof List<?> l && l.stream().anyMatch(d -> d instanceof Number n && n.intValue() == Days.localWeekday(now, s.timezone()));
    return trading && hour >= s.openingHour() && hour < s.closingHour();
  }

  /** Handles one message: the database work in one transaction, then the replies. */
  void process(Incoming msg) {
    String b = store.getGlobal(NUMBERS, msg.phoneNumberId()).map(l -> str(l.get("businessId"))).orElse(null);
    if (b == null) {
      log.warn("WhatsApp message for an unlinked number {}", msg.phoneNumberId());
      return;
    }
    List<String> replies = tx.execute(t -> handle(b, msg));
    if (replies == null) return;
    for (String reply : replies) send(b, msg.phoneNumberId(), msg.from(), reply);
  }

  private List<String> handle(String b, Incoming msg) {
    // WhatsApp may deliver the same message more than once: handle each id once.
    if (msg.messageId() != null && !msg.messageId().isEmpty()) {
      String id = msg.messageId().replaceAll("[^A-Za-z0-9_-]", "_");
      if (id.length() > 128) id = id.substring(0, 128);
      if (store.get(b, "whatsappInbound", id).isPresent()) return null;
      store.set(b, "whatsappInbound", id, Map.of("at", Op.serverTime()));
    }
    store.set(b, "whatsappMessages", store.newId(), Map.of("direction", "in", "waId", msg.from(), "name", msg.name(), "text", msg.text(), "at", Op.serverTime()));
    Settings settings = settingsService.read(b);
    if (!settings.flag("whatsapp", "ordering")) {
      return List.of("Thanks for your message! " + settings.businessName() + " is not taking WhatsApp orders at the moment.");
    }
    String today = Effects.todayKey(settings);
    var products = store.list(b, Query.of("products").where("active", "==", true).orderBy("sortOrder", false).build());
    boolean shiftOpen = !store.list(b, Query.of("shifts").where("status", "==", "open").limit(1).build()).isEmpty();
    var chat = store.getForUpdate(b, "whatsappChats", msg.from()).orElse(Map.of());
    var last = store.list(b, Query.of("orders").where("customerPhone", "==", msg.from()).where("dayKey", "==", today).orderBy("createdAtMillis", true).limit(1).build());

    List<WhatsAppBot.MenuItem> menu = products.stream().map(p -> new WhatsAppBot.MenuItem(str(p.get("id")), str(p.get("name")), cents(p.get("priceCents")))).toList();
    var context = new WhatsAppBot.Context(settings.businessName(), menu, isOpenNow(settings, Instant.now()) && shiftOpen,
        "We take orders from " + settings.openingHour() + ":00 to " + settings.closingHour() + ":00.",
        last.isEmpty() ? null : waLabel(last.get(0).get("ticketNo")), last.isEmpty() ? null : str(last.get(0).get("status")));
    var result = WhatsAppBot.handleIncoming(msg.text(), WhatsAppBot.ChatState.of(Domain.map(chat.get("state"))), context);
    List<String> replies = new ArrayList<>(result.replies());

    if (result.placeLines() != null) {
      Map<String, Map<String, Object>> byId = new LinkedHashMap<>();
      products.forEach(p -> byId.put(str(p.get("id")), p));
      List<WhatsAppBot.DraftLine> items = result.placeLines().stream().filter(l -> byId.containsKey(l.productId())).toList();
      long total = WhatsAppBot.draftTotal(items);
      store.merge(b, "orderCounters", today, Map.of("n", Op.inc(1)));
      long n = cents(store.get(b, "orderCounters", today).orElseThrow().get("n"));
      String customerName = msg.name().isEmpty() ? WhatsAppBot.displayPhone(msg.from()) : msg.name();
      String itemsText = String.join(", ", items.stream().map(l -> l.quantity() + "× " + l.name()).toList());
      Map<String, Object> order = new LinkedHashMap<>();
      order.put("receiptNo", null);
      order.put("ticketNo", n);
      order.put("lines", items.stream().filter(l -> Domain.inOrderQueue(byId.get(l.productId()))).map(l -> Map.of("name", l.name(), "quantity", l.quantity())).toList());
      if (!result.placeNote().isEmpty()) order.put("note", result.placeNote());
      order.put("status", "new");
      order.put("source", "whatsapp");
      order.put("customerPhone", msg.from());
      order.put("customerName", customerName);
      order.put("items", items.stream().map(WhatsAppBot.DraftLine::toMap).toList());
      order.put("totalCents", total);
      order.put("paid", false);
      order.put("createdAtMillis", System.currentTimeMillis());
      order.put("createdBy", "whatsapp");
      order.put("createdByName", "WhatsApp · " + customerName);
      order.put("dayKey", today);
      order.put("updatedBy", "whatsapp");
      order.put("updatedAt", Op.serverTime());
      store.set(b, "orders", store.newId(), order);
      var a = Notifier.alert("whatsappOrder", "info", "WhatsApp order " + waLabel(n) + ": " + Domain.formatZar(total))
          .message(customerName + " ordered " + itemsText + ".")
          .detail("Customer", customerName + " (" + WhatsAppBot.displayPhone(msg.from()) + ")")
          .detail("Items", itemsText)
          .detail("Total to collect", Domain.formatZar(total));
      if (!result.placeNote().isEmpty()) a.detail("Note", result.placeNote());
      notifier.notify(b, settings, a.actor("WhatsApp").link("/orders"));
      replies.add("✅ Order *#" + waLabel(n) + "* received! Total *" + Domain.formatZar(total) + "*, pay when you collect.\nWe'll message you here when it's ready. Reply *status* any time.");
    }
    store.merge(b, "whatsappChats", msg.from(), Map.of("state", result.state().toMap(), "name", msg.name(), "lastAt", Op.serverTime()));
    return replies;
  }

  /** Tells the customer when staff move their WhatsApp order along the queue (once the change is saved). */
  @TransactionalEventListener
  public void orderStatusChanged(OrderActions.StatusChanged e) {
    Map<String, Object> after = e.after();
    if (!"whatsapp".equals(after.get("source")) || after.get("customerPhone") == null) return;
    Settings settings = settingsService.read(e.businessId());
    String text = WhatsAppBot.statusMessage(str(after.get("status")), waLabel(after.get("ticketNo")), settings.businessName(), cents(after.get("totalCents")),
        Boolean.TRUE.equals(after.get("paid")));
    String numberId = settings.text("whatsapp", "phoneNumberId");
    if (text != null && !numberId.isEmpty()) send(e.businessId(), numberId, str(after.get("customerPhone")), text);
  }

  @Operation(summary = "Link the shop's WhatsApp Business number", description = "Owner only: the phone number ID from Meta, the number customers see, and ordering on/off.")
  @PostMapping("/api/rpc/linkWhatsapp")
  @Transactional
  public Map<String, Object> linkWhatsapp(@AuthenticationPrincipal Jwt jwt, @RequestBody Map<String, Object> data) {
    Body d = Body.of(data);
    Caller owner = ctx.require(jwt, d, "owner");
    String phoneNumberId = d.str("phoneNumberId").trim();
    if (!phoneNumberId.isEmpty() && !phoneNumberId.matches("^\\d{6,25}$")) throw ApiException.invalid("The phone number ID is the long number from Meta (digits only)");
    String displayNumber = d.has("displayNumber") && !d.str("displayNumber").isEmpty() ? d.text("displayNumber", "WhatsApp number", 6, 30) : "";
    boolean ordering = d.bool("ordering");
    if (ordering && phoneNumberId.isEmpty()) throw ApiException.invalid("Enter the phone number ID before turning ordering on");
    String b = owner.businessId();
    Settings settings = settingsService.read(b);
    if (!phoneNumberId.isEmpty()) {
      var existing = store.getGlobal(NUMBERS, phoneNumberId);
      if (existing.isPresent() && !b.equals(existing.get().get("businessId"))) throw ApiException.exists("That WhatsApp number is linked to another shop");
    }
    String previous = settings.text("whatsapp", "phoneNumberId");
    if (!previous.isEmpty() && !previous.equals(phoneNumberId)) store.deleteGlobal(NUMBERS, previous);
    if (!phoneNumberId.isEmpty()) store.setGlobal(NUMBERS, phoneNumberId, Map.of("businessId", b, "updatedAt", Op.serverTime()));
    store.merge(b, SettingsService.COLLECTION, SettingsService.DOC, Map.of("whatsapp", Map.of("ordering", ordering, "phoneNumberId", phoneNumberId, "displayNumber", displayNumber)));
    audit.record(owner, "whatsapp.linked", "businessSettings", "main", Map.of("ordering", ordering, "phoneNumberId", phoneNumberId, "displayNumber", displayNumber));
    return Map.of("ok", true);
  }
}
