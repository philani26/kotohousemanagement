package za.co.kotahouse.store;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirements;
import io.swagger.v3.oas.annotations.tags.Tag;
import java.io.IOException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.Map;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import za.co.kotahouse.auth.TokenService;
import za.co.kotahouse.common.ApiException;
import za.co.kotahouse.shop.Caller;
import za.co.kotahouse.shop.ShopAccess;

/**
 * Receipt photos and slips (what Firebase Storage did, same rules): staff
 * upload into their own folder, at most 5 MB, images or PDF, never overwrite;
 * only the owner or the uploader can view one. Kept in PostgreSQL until the
 * AWS deployment moves them to S3.
 */
@RestController
@Tag(name = "Receipt photos")
public class FileController {
  private static final long MAX_BYTES = 5L * 1024 * 1024;
  private static final long LINK_SECONDS = 300;
  private static final SecureRandom RANDOM = new SecureRandom();

  private final JdbcClient db;
  private final ShopAccess access;
  private final TokenService tokens;

  public FileController(JdbcClient db, ShopAccess access, TokenService tokens) {
    this.db = db;
    this.access = access;
    this.tokens = tokens;
  }

  @Operation(summary = "Upload a receipt photo or PDF", description = "Owner and cashiers. Returns the path to send with the expense or delivery.")
  @PostMapping(path = "/api/shops/{businessId}/files", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
  public Map<String, Object> upload(@AuthenticationPrincipal Jwt jwt, @PathVariable String businessId, @RequestParam("file") MultipartFile file) throws IOException {
    Caller c = access.require(jwt, businessId, "owner", "employee");
    String type = file.getContentType() == null ? "" : file.getContentType();
    if (!type.startsWith("image/") && !type.equals("application/pdf")) throw ApiException.invalid("Receipt must be a photo or PDF");
    if (file.getSize() > MAX_BYTES) throw ApiException.invalid("Receipt file is too large (max 5 MB)");
    byte[] r = new byte[4];
    RANDOM.nextBytes(r);
    String ext = type.equals("application/pdf") ? "pdf" : "jpg";
    String path = "businesses/" + businessId + "/receipts/" + c.uid() + "/" + System.currentTimeMillis() + "-" + HexFormat.of().formatHex(r) + "." + ext;
    db.sql("insert into files (path, business_id, uploaded_by, content_type, bytes) values (:p, :b, :u, :t, :d)")
        .param("p", path).param("b", businessId).param("u", c.uid()).param("t", type).param("d", file.getBytes()).update();
    return Map.of("path", path);
  }

  @Operation(summary = "A five-minute link to view a receipt", description = "Only the owner or the person who uploaded it.")
  @GetMapping("/api/shops/{businessId}/files/link")
  public Map<String, Object> link(@AuthenticationPrincipal Jwt jwt, @PathVariable String businessId, @RequestParam String path) {
    Caller c = access.require(jwt, businessId, "owner", "employee");
    String uploader = db.sql("select uploaded_by from files where path = :p and business_id = :b").param("p", path).param("b", businessId)
        .query(String.class).optional().orElseThrow(() -> ApiException.notFound("Receipt not found"));
    if (!c.isOwner() && !c.uid().equals(uploader)) throw ApiException.denied("You do not have access to this receipt");
    long expires = System.currentTimeMillis() / 1000 + LINK_SECONDS;
    String sig = tokens.sign("file", path + "|" + expires);
    return Map.of("url", "/api/files/view?path=" + URLEncoder.encode(path, StandardCharsets.UTF_8) + "&expires=" + expires + "&sig=" + sig);
  }

  @Operation(summary = "Open a receipt with a signed link")
  @SecurityRequirements
  @GetMapping("/api/files/view")
  public ResponseEntity<byte[]> view(@RequestParam String path, @RequestParam long expires, @RequestParam String sig) {
    boolean valid = expires >= System.currentTimeMillis() / 1000
        && MessageDigest.isEqual(tokens.sign("file", path + "|" + expires).getBytes(StandardCharsets.UTF_8), sig.getBytes(StandardCharsets.UTF_8));
    if (!valid) throw ApiException.denied("This link has expired – open the receipt again");
    record F(String type, byte[] bytes) {}
    F f = db.sql("select content_type, bytes from files where path = :p").param("p", path)
        .query((rs, i) -> new F(rs.getString(1), rs.getBytes(2))).optional()
        .orElseThrow(() -> ApiException.notFound("Receipt not found"));
    return ResponseEntity.ok().contentType(MediaType.parseMediaType(f.type())).cacheControl(CacheControl.noStore())
        .header("Content-Disposition", "inline").header("X-Content-Type-Options", "nosniff").body(f.bytes());
  }
}
