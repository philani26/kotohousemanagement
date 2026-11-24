package za.co.kotahouse.cards;

import static za.co.kotahouse.domain.Domain.cents;
import static za.co.kotahouse.domain.Domain.formatZar;
import static za.co.kotahouse.domain.Domain.map;
import static za.co.kotahouse.domain.Domain.str;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;
import za.co.kotahouse.actions.Notifier;
import za.co.kotahouse.common.ApiException;
import za.co.kotahouse.common.Days;
import za.co.kotahouse.domain.CardMatching;
import za.co.kotahouse.settings.Settings;
import za.co.kotahouse.settings.SettingsService;
import za.co.kotahouse.store.Op;
import za.co.kotahouse.store.Query;
import za.co.kotahouse.store.Store;
import za.co.kotahouse.store.Ts;

/**
 * Card-machine transactions from any provider (CSV upload or webhook), matched
 * to the shop's card sales. A matched sale is marked verified, as if the owner
 * had ticked it off against the slip. Call inside a transaction.
 */
@Service
public class CardService {
  public static final String COLLECTION = "cardTransactions";
  private static final Pattern NOT_APPROVED = Pattern.compile("(?i).*(declin|fail|revers|void|cancel|reject|error|refund).*");
  /** how far back unmatched payments and sales are considered */
  private static final int LOOKBACK_DAYS = 8;
  public static final int MAX_ROWS = 5000;

  private final Store store;
  private final SettingsService settingsService;
  private final Notifier notifier;

  public CardService(Store store, SettingsService settingsService, Notifier notifier) {
    this.store = store;
    this.settingsService = settingsService;
    this.notifier = notifier;
  }

  public record Imported(int added, int duplicates, int matched, int unmatched) {}

  /**
   * Stores transactions (repeats are ignored: the id comes from provider, time,
   * amount and reference) and matches everything still open.
   * rows: {atMillis, amountCents, reference?, status?, last4?, terminal?}
   */
  public Imported ingest(String b, String provider, String source, String byUid, List<Map<String, Object>> rows) {
    String prov = provider == null || provider.isBlank() ? "Card machine" : provider.trim();
    if (prov.length() > 40) prov = prov.substring(0, 40);
    if (rows.size() > MAX_ROWS) throw ApiException.invalid("At most " + MAX_ROWS + " transactions at a time");
    Settings settings = settingsService.read(b);
    long now = System.currentTimeMillis();
    int added = 0;
    int dupes = 0;
    for (Map<String, Object> r : rows) {
      if (!(r.get("atMillis") instanceof Number at) || !(r.get("amountCents") instanceof Number amt)) throw ApiException.invalid("Each transaction needs a time and an amount");
      long atMs = at.longValue();
      long amount = Math.round(amt.doubleValue());
      if (atMs > now + 86_400_000L || atMs < now - 400L * 86_400_000L) throw ApiException.invalid("A transaction date is out of range – check the date column");
      if (Math.abs(amount) > 100_000_000) throw ApiException.invalid("An amount looks wrong – check the amount column");
      String reference = clip(r.get("reference"), 80);
      String status = clip(r.get("status"), 40);
      String id = "ct_" + hash(prov + "|" + atMs + "|" + amount + "|" + (reference == null ? "" : reference));
      if (store.get(b, COLLECTION, id).isPresent()) {
        dupes++;
        continue;
      }
      Map<String, Object> t = new LinkedHashMap<>();
      t.put("provider", prov);
      t.put("source", source);
      t.put("atMillis", atMs);
      t.put("amountCents", amount);
      if (reference != null) t.put("reference", reference);
      if (status != null) t.put("status", status);
      t.put("approved", amount > 0 && (status == null || !NOT_APPROVED.matcher(status).matches()));
      String last4 = clip(r.get("last4"), 4);
      if (last4 != null) t.put("last4", last4);
      String terminal = clip(r.get("terminal"), 40);
      if (terminal != null) t.put("terminal", terminal);
      t.put("dayKey", Days.dayKey(Instant.ofEpochMilli(atMs), settings.timezone()));
      t.put("matchedSaleId", null);
      t.put("importedBy", byUid);
      t.put("importedAt", Op.serverTime());
      store.set(b, COLLECTION, id, t);
      added++;
    }
    var result = reconcile(b, settings);
    return new Imported(added, dupes, result.matched(), result.unmatched());
  }

  public record Reconciled(int matched, int unmatched) {}

  /** Matches open card payments to open card sales of the last week. */
  public Reconciled reconcile(String b, Settings settings) {
    String since = LocalDate.now(ZoneId.of(settings.timezone())).minusDays(LOOKBACK_DAYS).toString();
    var txnDocs = store.listForUpdate(b, Query.of(COLLECTION).where("matchedSaleId", "==", null).where("dayKey", ">=", since).limit(MAX_ROWS).build());
    if (txnDocs.isEmpty()) return new Reconciled(0, 0);
    var saleDocs = store.listForUpdate(b, Query.of("sales").where("payment.method", "==", "card").where("dayKey", ">=", since).limit(MAX_ROWS).build());

    List<CardMatching.Txn> txns = new ArrayList<>();
    Map<String, Map<String, Object>> txnById = new LinkedHashMap<>();
    for (var t : txnDocs) {
      txns.add(new CardMatching.Txn(str(t.get("id")), cents(t.get("atMillis")), cents(t.get("amountCents")), Boolean.TRUE.equals(t.get("approved"))));
      txnById.put(str(t.get("id")), t);
    }
    List<CardMatching.Sale> sales = new ArrayList<>();
    Map<String, Map<String, Object>> saleById = new LinkedHashMap<>();
    for (var s : saleDocs) {
      Map<String, Object> pay = map(s.get("payment"));
      if (pay.get("cardTxnId") != null || pay.get("yocoCheckoutId") != null) continue; // already paid by a known payment
      Long at = Ts.millis(s.get("soldAt") != null ? s.get("soldAt") : s.get("createdAt"));
      if (at == null) continue;
      long card = cents(s.get("totalCents")) - Math.min(cents(pay.get("cashCents")), cents(s.get("totalCents")));
      sales.add(new CardMatching.Sale(str(s.get("id")), at, card));
      saleById.put(str(s.get("id")), s);
    }
    var matches = CardMatching.match(txns, sales, CardMatching.DEFAULT_WINDOW_MS);
    for (var m : matches) link(b, txnById.get(m.txnId()), saleById.get(m.saleId()), "auto");
    long open = txns.stream().filter(CardMatching.Txn::approved).count() - matches.size();
    return new Reconciled(matches.size(), (int) open);
  }

  /** Marks the sale as paid by this machine transaction (by: "auto" or the owner's uid). */
  public void link(String b, Map<String, Object> txn, Map<String, Object> sale, String by) {
    String txnId = str(txn.get("id"));
    String saleId = str(sale.get("id"));
    Map<String, Object> pay = map(sale.get("payment"));
    Map<String, Object> changes = new LinkedHashMap<>();
    changes.put("payment.verified", true);
    changes.put("payment.verifiedBy", "auto".equals(by) ? "card:" + txn.get("provider") : by);
    changes.put("payment.verifiedAt", Op.serverTime());
    changes.put("payment.cardTxnId", txnId);
    if (pay.get("reference") == null && txn.get("reference") != null) changes.put("payment.reference", txn.get("reference"));
    store.update(b, "sales", saleId, changes);
    store.update(b, COLLECTION, txnId, Map.of("matchedSaleId", saleId, "matchedBy", by, "matchedAt", Op.serverTime()));
  }

  /** Undoes a match: the sale goes back to unverified. */
  public void unlink(String b, Map<String, Object> txn) {
    Object saleId = txn.get("matchedSaleId");
    if (saleId != null) {
      store.get(b, "sales", str(saleId)).ifPresent(s -> {
        Map<String, Object> changes = new LinkedHashMap<>();
        changes.put("payment.verified", false);
        changes.put("payment.cardTxnId", Op.delete());
        store.update(b, "sales", str(saleId), changes);
      });
    }
    Map<String, Object> clear = new LinkedHashMap<>();
    clear.put("matchedSaleId", null);
    clear.put("matchedBy", Op.delete());
    store.update(b, COLLECTION, str(txn.get("id")), clear);
  }

  /** One alert for payments the machine took that no sale explains (e.g. food handed over but not rung up). */
  public void alertUnexplained(String b, String context) {
    Settings settings = settingsService.read(b);
    long cutoff = System.currentTimeMillis() - CardMatching.DEFAULT_WINDOW_MS;
    String since = LocalDate.now(ZoneId.of(settings.timezone())).minusDays(LOOKBACK_DAYS).toString();
    var open = store.list(b, Query.of(COLLECTION).where("matchedSaleId", "==", null).where("approved", "==", true).where("dayKey", ">=", since)
        .orderBy("atMillis", false).limit(200).build()).stream().filter(t -> cents(t.get("atMillis")) < cutoff).toList();
    if (open.isEmpty()) return;
    long total = open.stream().mapToLong(t -> cents(t.get("amountCents"))).sum();
    var a = Notifier.alert("cardUnmatched", "warning", open.size() + " card payment" + (open.size() == 1 ? "" : "s") + " with no sale (" + formatZar(total) + ")")
        .message("The card machine took these payments but no matching card sale was rung up in the app (" + context + ").");
    open.stream().limit(10).forEach(t -> a.detail(Days.localTime(Instant.ofEpochMilli(cents(t.get("atMillis"))), settings.timezone()),
        formatZar(cents(t.get("amountCents"))) + " · " + t.get("provider") + (t.get("reference") != null ? " · " + t.get("reference") : ""), "bad"));
    if (open.size() > 10) a.detail("And", (open.size() - 10) + " more – see Card machines");
    notifier.notify(b, settings, a.actor("Card check")
        .action("A payment with no sale means food may have been handed over without a sale – check Card machines and match or explain each one.")
        .link("/cards"), "cardUnmatched_" + Days.dayKey(Instant.now(), settings.timezone()));
  }

  private static String clip(Object v, int max) {
    if (v == null) return null;
    String s = v.toString().trim();
    if (s.isEmpty()) return null;
    return s.length() > max ? s.substring(0, max) : s;
  }

  private static String hash(String s) {
    try {
      return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8))).substring(0, 24);
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException(e);
    }
  }
}
