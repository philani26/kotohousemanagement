package za.co.kotahouse.store;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.MediaType;
import za.co.kotahouse.ApiTestBase;

/** Receipt photos: upload into your own folder, viewable by the owner or the uploader via a short signed link. */
class FilesIT extends ApiTestBase {
  @LocalServerPort
  int localPort;

  private Res upload(TestShop s, Person p, byte[] bytes, MediaType type) {
    org.springframework.http.HttpHeaders partHeaders = new org.springframework.http.HttpHeaders();
    partHeaders.setContentType(type);
    partHeaders.setContentDispositionFormData("file", "slip.jpg");
    org.springframework.util.LinkedMultiValueMap<String, Object> form = new org.springframework.util.LinkedMultiValueMap<>();
    form.add("file", new org.springframework.http.HttpEntity<>(new ByteArrayResource(bytes) {
      @Override
      public String getFilename() {
        return "slip.jpg";
      }
    }, partHeaders));
    return http.post().uri("/api/shops/" + s.businessId() + "/files").header("Authorization", "Bearer " + p.token())
        .contentType(MediaType.MULTIPART_FORM_DATA).body(form)
        .exchange((rq, rs) -> {
          byte[] b = rs.getBody().readAllBytes();
          @SuppressWarnings("unchecked")
          var m = b.length == 0 ? null : (java.util.Map<String, Object>) new tools.jackson.databind.json.JsonMapper().readValue(b, java.util.Map.class);
          return new Res(rs.getStatusCode().value(), m, null);
        });
  }

  @Test
  void receiptsAreUploadedAndOnlyTheOwnerOrUploaderCanSeeThem() throws Exception {
    TestShop s = newShop();
    Person cashier = addStaff(s, "employee", "Sipho");
    Person other = addStaff(s, "employee", "Lerato");
    byte[] jpeg = {(byte) 0xFF, (byte) 0xD8, (byte) 0xFF, 1, 2, 3};

    assertThat(upload(s, cashier, "not a photo".getBytes(), MediaType.TEXT_PLAIN).status()).isEqualTo(400);
    Res up = upload(s, cashier, jpeg, MediaType.IMAGE_JPEG);
    assertThat(up.status()).isEqualTo(200);
    String path = up.get("path");
    assertThat(path).startsWith("businesses/" + s.businessId() + "/receipts/" + cashier.uid() + "/");

    assertThat(get("/api/shops/" + s.businessId() + "/files/link?path=" + path, other.token()).status()).isEqualTo(403);
    String url = get("/api/shops/" + s.businessId() + "/files/link?path=" + path, s.owner().token()).get("url");
    HttpResponse<byte[]> res = HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create("http://localhost:" + localPort + url)).build(), HttpResponse.BodyHandlers.ofByteArray());
    assertThat(res.statusCode()).isEqualTo(200);
    assertThat(res.body()).isEqualTo(jpeg);
    // a tampered link doesn't open
    HttpResponse<byte[]> bad = HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create("http://localhost:" + localPort + url.replace("sig=", "sig=x"))).build(),
        HttpResponse.BodyHandlers.ofByteArray());
    assertThat(bad.statusCode()).isEqualTo(403);

    // and the path is accepted with an expense
    Res expense = post("/api/rpc/submitExpense", cashier.token(), body("businessId", s.businessId(), "amountCents", 500, "category", "Gas",
        "description", "Gas refill", "date", "2026-01-01", "paidFromTill", false, "receiptPath", path));
    assertThat(expense.status()).isEqualTo(200);
  }
}
