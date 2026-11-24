package za.co.kotahouse.listen;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.transaction.support.TransactionTemplate;
import za.co.kotahouse.ApiTestBase;
import za.co.kotahouse.store.Query;
import za.co.kotahouse.store.Store;

/** The owner listens live to a shop device: only when switched on, with the worker's notice accepted, logged, never stored. */
class ListeningIT extends ApiTestBase {
  @Autowired
  Store store;

  @Autowired
  TransactionTemplate tx;

  private static final String TABLET = "11111111-2222-4333-8444-555555555555";

  private Res rpc(TestShop s, Person p, String name, Map<String, Object> data) {
    Map<String, Object> m = new HashMap<>(data);
    m.put("businessId", s.businessId());
    return post("/api/rpc/" + name, p.token(), m);
  }

  private Map<String, Object> audio(TestShop s, Person p, String sessionId, String device, byte[] bytes) {
    return http.post().uri("/api/shops/" + s.businessId() + "/listen/" + sessionId + "/audio")
        .header("Authorization", "Bearer " + p.token()).header("X-Device-Id", device)
        .contentType(MediaType.APPLICATION_OCTET_STREAM).body(bytes)
        .retrieve().body(new org.springframework.core.ParameterizedTypeReference<Map<String, Object>>() {});
  }

  @Test
  void ownerListensOpenlyToAShopDevice() throws Exception {
    TestShop s = newShop();
    String b = s.businessId();
    Person cashier = addStaff(s, "employee", "Sipho");
    tx.executeWithoutResult(t -> store.set(b, "devices", TABLET, Map.of("label", "Counter tablet", "code", "1111", "status", "approved",
        "lastUid", cashier.uid(), "lastUserName", "Sipho", "lastSeenMillis", System.currentTimeMillis())));

    // off until the owner switches it on
    assertThat(rpc(s, s.owner(), "startListening", body("targetDevice", TABLET)).code()).isEqualTo("failed-precondition");
    assertThat(rpc(s, s.owner(), "saveCatalog", body("writes", List.of(Map.of("collection", "businessSettings",
        "data", Map.of("devices", Map.of("lockToApproved", false, "awayAlertMinutes", 60, "shareLocation", false, "allowListening", true))))))
        .status()).isEqualTo(200);

    // the worker on the device hasn't accepted the notice yet; staff can't start it
    Res notYet = rpc(s, s.owner(), "startListening", body("targetDevice", TABLET));
    assertThat(notYet.code()).isEqualTo("failed-precondition");
    assertThat((String) notYet.get("message")).contains("Sipho");
    assertThat(rpc(s, cashier, "startListening", body("targetDevice", TABLET)).status()).isEqualTo(403);
    assertThat(rpc(s, cashier, "acceptListeningNotice", Map.of()).status()).isEqualTo(200);

    Res started = rpc(s, s.owner(), "startListening", body("targetDevice", TABLET));
    assertThat(started.status()).isEqualTo(200);
    String sessionId = started.get("sessionId");
    // the device sees it (that's how it knows to start, and shows the banner)
    Res rec = get("/api/shops/" + b + "/data/listenSessions/" + TABLET, cashier.token());
    assertThat(rec.body()).containsEntry("active", true).containsEntry("sessionId", sessionId).containsEntry("ownerName", "Thandi");

    // the owner's stream receives what the device sends
    HttpClient client = HttpClient.newHttpClient();
    HttpResponse<InputStream> stream = client.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/shops/" + b + "/listen/" + sessionId + "/stream"))
        .header("Authorization", "Bearer " + s.owner().token()).header("Accept", "text/event-stream").build(), HttpResponse.BodyHandlers.ofInputStream());
    assertThat(stream.statusCode()).isEqualTo(200);
    byte[] chunk = {1, 2, 3, (byte) 0xff};
    CompletableFuture<String> heard = CompletableFuture.supplyAsync(() -> {
      try {
        StringBuilder seen = new StringBuilder();
        byte[] buf = new byte[1024];
        int n;
        while ((n = stream.body().read(buf)) > 0) {
          seen.append(new String(buf, 0, n, StandardCharsets.UTF_8));
          if (seen.indexOf("event:audio") >= 0 && seen.indexOf("\n\n", seen.indexOf("event:audio")) > 0) return seen.toString();
        }
        return seen.toString();
      } catch (Exception e) {
        return e.toString();
      }
    });
    Thread.sleep(300);
    assertThat(audio(s, cashier, sessionId, TABLET, chunk)).containsEntry("active", true);
    assertThat(heard.get(5, TimeUnit.SECONDS)).contains(Base64.getEncoder().encodeToString(chunk));

    // another device can't feed this session
    assertThat(audio(s, cashier, sessionId, "99999999-2222-4333-8444-555555555555", chunk)).containsEntry("active", false);

    // stop: the device is told, its audio is refused, and both ends are in the activity log
    assertThat(rpc(s, s.owner(), "stopListening", body("targetDevice", TABLET)).status()).isEqualTo(200);
    assertThat(get("/api/shops/" + b + "/data/listenSessions/" + TABLET, cashier.token()).body()).containsEntry("active", false);
    assertThat(audio(s, cashier, sessionId, TABLET, chunk)).containsEntry("active", false);
    var actions = store.list(b, Query.of("auditLogs").build()).stream().map(a -> a.get("action")).toList();
    assertThat(actions).contains("listening.started", "listening.stopped", "listening.noticeAccepted");
    stream.body().close();
  }
}
