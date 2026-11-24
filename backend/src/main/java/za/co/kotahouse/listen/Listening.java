package za.co.kotahouse.listen;

import static za.co.kotahouse.domain.Domain.str;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import java.io.IOException;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import jakarta.annotation.PreDestroy;
import org.springframework.http.MediaType;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import za.co.kotahouse.actions.Body;
import za.co.kotahouse.actions.Ctx;
import za.co.kotahouse.audit.AuditLog;
import za.co.kotahouse.common.ApiException;
import za.co.kotahouse.domain.Domain;
import za.co.kotahouse.settings.SettingsService;
import za.co.kotahouse.shop.Caller;
import za.co.kotahouse.shop.ShopAccess;
import za.co.kotahouse.store.Op;
import za.co.kotahouse.store.Store;

/**
 * The owner listens live to a shop device's microphone (e.g. the till tablet).
 *
 * Open by design, never hidden: the owner must switch it on and confirm staff
 * and customers were told; each worker accepts a notice once; the device shows
 * a banner the whole time; every session is in the activity log; nothing is
 * recorded – audio only passes through this server's memory to the listener.
 *
 * The record listenSessions/{deviceId} tells the device to start or stop. The
 * device posts small audio chunks (8 kHz μ-law, like a phone call); they are
 * pushed to the owner's open stream. A session ends when the owner stops, when
 * nobody has been listening for a while, or after {@link #MAX_MINUTES}.
 */
@RestController
@Tag(name = "Live listening")
public class Listening {
  public static final String COLLECTION = "listenSessions";
  static final int MAX_MINUTES = 30;
  /** the device must have checked in this recently to be listened to */
  static final long ONLINE_MS = 5 * 60_000L;
  /** a session with no listener connected for this long ends by itself */
  static final long NO_LISTENER_MS = 45_000L;
  static final int MAX_CHUNK_BYTES = 16_000;

  private final Ctx ctx;
  private final ShopAccess access;
  private final Store store;
  private final SettingsService settings;
  private final AuditLog audit;
  private final TransactionTemplate tx;
  private final SecureRandom random = new SecureRandom();
  private final Map<String, Session> sessions = new ConcurrentHashMap<>();
  private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(r -> {
    Thread t = new Thread(r, "listen-timer");
    t.setDaemon(true);
    return t;
  });

  static final class Session {
    final String id;
    final String businessId;
    final String deviceId;
    final String ownerUid;
    final long startedAt = System.currentTimeMillis();
    final Set<SseEmitter> listeners = new CopyOnWriteArraySet<>();
    volatile long lastListenerAt = System.currentTimeMillis();
    volatile long audioChunks;

    Session(String id, String businessId, String deviceId, String ownerUid) {
      this.id = id;
      this.businessId = businessId;
      this.deviceId = deviceId;
      this.ownerUid = ownerUid;
    }
  }

  public Listening(Ctx ctx, ShopAccess access, Store store, SettingsService settings, AuditLog audit, TransactionTemplate tx) {
    this.ctx = ctx;
    this.access = access;
    this.store = store;
    this.settings = settings;
    this.audit = audit;
    this.tx = tx;
    timer.scheduleAtFixedRate(this::expire, 10, 10, TimeUnit.SECONDS);
  }

  @PreDestroy
  void stopTimer() {
    timer.shutdownNow();
  }

  // ------------------------------------------------------------------ owner: start / stop

  @Operation(summary = "Start listening to a shop device", description = """
      Owner only. targetDevice: the device id. Needs "Allow live listening" switched on (Devices page), an approved device \
      that checked in within the last 5 minutes, and – when a worker is signed in on it – that worker's accepted notice. \
      Returns sessionId; open GET /api/shops/{b}/listen/{sessionId}/stream to hear it.""")
  @PostMapping("/api/rpc/startListening")
  @Transactional
  public Map<String, Object> start(@AuthenticationPrincipal Jwt jwt, @RequestBody Map<String, Object> data) {
    Body d = Body.of(data);
    Caller owner = ctx.require(jwt, d, "owner");
    String b = owner.businessId();
    if (!settings.read(b).flag("devices", "allowListening")) {
      throw ApiException.precondition("Switch on live listening on the Devices page first");
    }
    String deviceId = d.str("targetDevice");
    Map<String, Object> device = store.get(b, "devices", deviceId).orElseThrow(() -> ApiException.notFound("Device not found"));
    if (!"approved".equals(device.get("status"))) throw ApiException.precondition("Only approved shop devices can be listened to");
    if (System.currentTimeMillis() - Domain.num(device.get("lastSeenMillis")) > ONLINE_MS) {
      throw ApiException.precondition("That device is not online – open Kota House on it first");
    }
    String user = str(device.get("lastUid"));
    if (!user.isEmpty() && !user.equals(owner.uid()) && !acceptedNotice(b, user)) {
      throw ApiException.precondition(str(device.get("lastUserName")) + " hasn't accepted the listening notice yet – it shows on their next sign-in");
    }

    // one session per device: a new one replaces the old
    sessions.values().removeIf(s -> s.businessId.equals(b) && s.deviceId.equals(deviceId) && close(s));
    String id = HexFormat.of().formatHex(bytes(16));
    sessions.put(id, new Session(id, b, deviceId, owner.uid()));

    Map<String, Object> rec = new LinkedHashMap<>();
    rec.put("deviceId", deviceId);
    rec.put("active", true);
    rec.put("sessionId", id);
    rec.put("ownerName", owner.name());
    rec.put("startedAtMillis", System.currentTimeMillis());
    rec.put("endedAtMillis", null);
    store.set(b, COLLECTION, deviceId, rec);
    audit.record(owner, "listening.started", "devices", deviceId, Map.of("device", str(device.get("label")), "workerOnDevice", str(device.get("lastUserName"))));
    return Map.of("sessionId", id, "maxMinutes", MAX_MINUTES);
  }

  @Operation(summary = "Stop listening", description = "Owner only. targetDevice: the device id.")
  @PostMapping("/api/rpc/stopListening")
  @Transactional
  public Map<String, Object> stop(@AuthenticationPrincipal Jwt jwt, @RequestBody Map<String, Object> data) {
    Body d = Body.of(data);
    Caller owner = ctx.require(jwt, d, "owner");
    String deviceId = d.str("targetDevice");
    sessions.values().removeIf(s -> s.businessId.equals(owner.businessId()) && s.deviceId.equals(deviceId) && close(s));
    markEnded(owner.businessId(), deviceId, null);
    audit.record(owner, "listening.stopped", "devices", deviceId, Map.of());
    return Map.of("ok", true);
  }

  @Operation(summary = "Accept the live-listening notice", description = "A worker confirms once that they were told the owner may listen live through shop devices.")
  @PostMapping("/api/rpc/acceptListeningNotice")
  @Transactional
  public Map<String, Object> accept(@AuthenticationPrincipal Jwt jwt, @RequestBody Map<String, Object> data) {
    Caller c = ctx.require(jwt, Body.of(data), Ctx.Options.SKIP_BOTH, "owner", "employee", "kitchen");
    if (!c.isOwner()) {
      store.update(c.businessId(), Store.EMPLOYEES, c.uid(), Map.of("listeningNoticeAt", Op.serverTime()));
      audit.record(c, "listening.noticeAccepted", "employees", c.uid(), Map.of());
    }
    return Map.of("ok", true);
  }

  // ------------------------------------------------------------------ device: send audio

  @Operation(summary = "Audio from the device (8 kHz μ-law bytes)", description = """
      Sent by the shop device while its listenSessions record is active. X-Device-Id must be that device. \
      Returns active=false when the session has ended, so the device stops its microphone.""")
  @PostMapping(path = "/api/shops/{businessId}/listen/{sessionId}/audio", consumes = MediaType.APPLICATION_OCTET_STREAM_VALUE)
  public Map<String, Object> audio(@AuthenticationPrincipal Jwt jwt, @PathVariable String businessId, @PathVariable String sessionId,
      @RequestHeader(name = "X-Device-Id", required = false) String deviceId, @RequestBody(required = false) byte[] chunk) {
    Caller c = access.require(jwt, businessId, "owner", "employee", "kitchen");
    Session s = sessions.get(sessionId);
    if (s == null || !s.businessId.equals(businessId) || !s.deviceId.equals(deviceId)) return Map.of("active", false);
    if (!c.isOwner() && !tx.execute(t -> acceptedNotice(businessId, c.uid()))) return Map.of("active", false);
    if (chunk == null || chunk.length == 0) return Map.of("active", true);
    if (chunk.length > MAX_CHUNK_BYTES) throw ApiException.invalid("Audio chunk too large");
    s.audioChunks++;
    String encoded = Base64.getEncoder().encodeToString(chunk);
    for (SseEmitter e : s.listeners) {
      try {
        e.send(SseEmitter.event().name("audio").data(encoded));
      } catch (IOException | IllegalStateException ex) {
        s.listeners.remove(e);
      }
    }
    return Map.of("active", true);
  }

  // ------------------------------------------------------------------ owner: hear it

  @Operation(summary = "Hear a session (server-sent events)", description = "Owner only. Sends \"audio\" events with base64 8 kHz μ-law; \"ended\" when the session stops.")
  @GetMapping(path = "/api/shops/{businessId}/listen/{sessionId}/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
  public SseEmitter stream(@AuthenticationPrincipal Jwt jwt, @PathVariable String businessId, @PathVariable String sessionId) {
    Caller owner = access.require(jwt, businessId, "owner");
    Session s = Optional.ofNullable(sessions.get(sessionId))
        .filter(x -> x.businessId.equals(businessId) && x.ownerUid.equals(owner.uid()))
        .orElseThrow(() -> ApiException.notFound("This listening session has ended"));
    long left = s.startedAt + MAX_MINUTES * 60_000L - System.currentTimeMillis();
    SseEmitter emitter = new SseEmitter(Math.max(1_000L, left + 5_000L));
    s.listeners.add(emitter);
    s.lastListenerAt = System.currentTimeMillis();
    Runnable gone = () -> {
      s.listeners.remove(emitter);
      s.lastListenerAt = System.currentTimeMillis();
    };
    emitter.onCompletion(gone);
    emitter.onTimeout(gone);
    emitter.onError(e -> gone.run());
    try {
      emitter.send(SseEmitter.event().name("ready").data("ok"));
    } catch (IOException e) {
      gone.run();
    }
    return emitter;
  }

  // ------------------------------------------------------------------ helpers

  boolean acceptedNotice(String businessId, String uid) {
    return store.get(businessId, Store.EMPLOYEES, uid).map(e -> e.get("listeningNoticeAt") != null).orElse(false);
  }

  /** Ends sessions nobody listens to any more, and those past the time limit. */
  void expire() {
    long now = System.currentTimeMillis();
    for (Session s : List.copyOf(sessions.values())) {
      boolean idle = s.listeners.isEmpty() && now - s.lastListenerAt > NO_LISTENER_MS;
      boolean tooLong = now - s.startedAt > MAX_MINUTES * 60_000L;
      if (idle || tooLong) {
        sessions.remove(s.id);
        close(s);
        try {
          tx.executeWithoutResult(t -> markEnded(s.businessId, s.deviceId, s.id));
        } catch (RuntimeException e) {
          // the device also stops when its audio is refused
        }
      }
    }
  }

  /** for tests: run the clean-up now */
  public void expireNow() {
    expire();
  }

  private void markEnded(String b, String deviceId, String onlySession) {
    store.get(b, COLLECTION, deviceId).ifPresent(rec -> {
      if (onlySession != null && !onlySession.equals(rec.get("sessionId"))) return;
      if (!Boolean.TRUE.equals(rec.get("active"))) return;
      store.update(b, COLLECTION, deviceId, Map.of("active", false, "endedAtMillis", System.currentTimeMillis()));
    });
  }

  private static boolean close(Session s) {
    for (SseEmitter e : s.listeners) {
      try {
        e.send(SseEmitter.event().name("ended").data("ended"));
        e.complete();
      } catch (IOException | IllegalStateException ignored) {
        // already gone
      }
    }
    s.listeners.clear();
    return true;
  }

  private byte[] bytes(int n) {
    byte[] b = new byte[n];
    random.nextBytes(b);
    return b;
  }
}
