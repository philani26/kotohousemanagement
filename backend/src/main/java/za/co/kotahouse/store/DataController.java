package za.co.kotahouse.store;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.springframework.http.MediaType;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import za.co.kotahouse.common.ApiException;
import za.co.kotahouse.shop.Caller;
import za.co.kotahouse.shop.ShopAccess;

/**
 * Read access to a shop's records for the app's screens (what the Firestore
 * SDK did), checked against {@link ReadRules}. All changes go through the
 * action endpoints; nothing here writes.
 */
@RestController
@RequestMapping("/api/shops/{businessId}")
@Tag(name = "Shop records", description = "Lists and records for the app's screens, plus live change notifications")
public class DataController {
  private static final long HEARTBEAT_SECONDS = 25;

  private final Store store;
  private final ShopAccess access;
  private final ChangeFeed feed;
  private final ScheduledExecutorService heartbeats = Executors.newSingleThreadScheduledExecutor(r -> {
    Thread t = new Thread(r, "sse-heartbeat");
    t.setDaemon(true);
    return t;
  });

  public DataController(Store store, ShopAccess access, ChangeFeed feed) {
    this.store = store;
    this.access = access;
    this.feed = feed;
  }

  private Caller caller(Jwt jwt, String businessId) {
    return access.require(jwt, businessId, "owner", "employee", "kitchen");
  }

  /** [field, operator, value] / [field, "asc"|"desc"] as the app builds them. */
  public record QueryRequest(String collection, List<List<Object>> where, List<List<String>> orderBy, Integer limit) {}

  @Operation(summary = "List records", description = """
      Operators: ==, !=, <, <=, >, >=, in. Example: {"collection": "sales", "where": [["dayKey", "==", "2026-11-02"]], \
      "orderBy": [["createdAt", "desc"]], "limit": 50}. People only get the records they may see (e.g. a cashier: their own sales).""")
  @PostMapping("/query")
  @Transactional(readOnly = true)
  public List<Map<String, Object>> query(@AuthenticationPrincipal Jwt jwt, @PathVariable String businessId, @RequestBody QueryRequest r) {
    Caller c = caller(jwt, businessId);
    if (r.collection() == null) throw ApiException.invalid("collection is required");
    Store.Condition limitToMine = ReadRules.listCondition(c, r.collection());
    Query.Builder q = Query.of(r.collection());
    try {
      for (List<Object> w : r.where() == null ? List.<List<Object>>of() : r.where()) {
        if (w.size() != 3) throw ApiException.invalid("where needs [field, operator, value]");
        q.where(String.valueOf(w.get(0)), String.valueOf(w.get(1)), w.get(2));
      }
    } catch (IllegalArgumentException e) {
      throw ApiException.invalid(e.getMessage());
    }
    for (List<String> o : r.orderBy() == null ? List.<List<String>>of() : r.orderBy()) {
      q.orderBy(o.get(0), o.size() > 1 && "desc".equalsIgnoreCase(o.get(1)));
    }
    q.limit(r.limit() == null ? 1000 : r.limit());
    return store.list(businessId, q.build(), false, limitToMine);
  }

  @Operation(summary = "One record", description = "Empty (204) if it doesn't exist; 403 if the person may not see it.")
  @GetMapping("/data/{collection}/{id}")
  @Transactional(readOnly = true)
  public Map<String, Object> get(@AuthenticationPrincipal Jwt jwt, @PathVariable String businessId, @PathVariable String collection, @PathVariable String id) {
    Caller c = caller(jwt, businessId);
    var doc = store.get(businessId, collection, id).orElse(null);
    if (doc == null) {
      if (!ReadRules.mayOpen(c, collection)) throw ApiException.denied("You do not have access to this information");
      return null;
    }
    if (!ReadRules.canGet(c, collection, doc)) throw ApiException.denied("You do not have access to this information");
    return doc;
  }

  @Operation(summary = "Live changes (server-sent events)", description = """
      Stays open; sends "changed" with the list of collections that changed in this shop, so the app reloads those lists. \
      A comment line every 25 s keeps the connection alive.""")
  @GetMapping(path = "/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public SseEmitter events(@AuthenticationPrincipal Jwt jwt, @PathVariable String businessId) {
    caller(jwt, businessId);
    SseEmitter emitter = new SseEmitter(30 * 60_000L); // the app reconnects after 30 min (and re-checks access)
    Runnable stop = feed.listen(businessId, (Set<String> collections) -> {
      try {
        emitter.send(SseEmitter.event().name("changed").data(collections));
      } catch (IOException | IllegalStateException e) {
        emitter.completeWithError(e);
      }
    });
    var beat = heartbeats.scheduleAtFixedRate(() -> {
      try {
        emitter.send(SseEmitter.event().comment("keep-alive"));
      } catch (IOException | IllegalStateException e) {
        emitter.completeWithError(e);
      }
    }, HEARTBEAT_SECONDS, HEARTBEAT_SECONDS, TimeUnit.SECONDS);
    Runnable cleanup = () -> {
      stop.run();
      beat.cancel(false);
    };
    emitter.onCompletion(cleanup);
    emitter.onTimeout(cleanup);
    emitter.onError(e -> cleanup.run());
    try {
      emitter.send(SseEmitter.event().name("ready").data("ok"));
    } catch (IOException e) {
      cleanup.run();
    }
    return emitter;
  }
}
