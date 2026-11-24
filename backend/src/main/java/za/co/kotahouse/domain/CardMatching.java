package za.co.kotahouse.domain;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Matches card-machine transactions to card sales, for any provider.
 * A transaction pays a sale when the amounts are equal (the sale's card part)
 * and the times are within the window; the closest time wins, and each
 * transaction and each sale is used at most once. Declined or reversed
 * transactions never match.
 */
public final class CardMatching {
  private CardMatching() {}

  public static final long DEFAULT_WINDOW_MS = 15 * 60_000L;

  /** A card payment as the machine's provider reports it. */
  public record Txn(String id, long atMillis, long amountCents, boolean approved) {}

  /** A card sale still waiting for its machine payment. */
  public record Sale(String id, long atMillis, long cardCents) {}

  public record Match(String txnId, String saleId, long gapMillis) {}

  public static List<Match> match(List<Txn> txns, List<Sale> sales, long windowMs) {
    record Pair(Txn t, Sale s, long gap) {}
    List<Pair> pairs = new ArrayList<>();
    for (Txn t : txns) {
      if (!t.approved() || t.amountCents() <= 0) continue;
      for (Sale s : sales) {
        long gap = Math.abs(s.atMillis() - t.atMillis());
        if (s.cardCents() == t.amountCents() && gap <= windowMs) pairs.add(new Pair(t, s, gap));
      }
    }
    // closest first; ties go to the earlier transaction, then the earlier sale, so results never depend on input order
    pairs.sort(Comparator.comparingLong(Pair::gap)
        .thenComparingLong(p -> p.t().atMillis()).thenComparing(p -> p.t().id())
        .thenComparingLong(p -> p.s().atMillis()).thenComparing(p -> p.s().id()));
    Set<String> usedT = new HashSet<>();
    Set<String> usedS = new HashSet<>();
    List<Match> out = new ArrayList<>();
    for (Pair p : pairs) {
      if (usedT.contains(p.t().id()) || usedS.contains(p.s().id())) continue;
      usedT.add(p.t().id());
      usedS.add(p.s().id());
      out.add(new Match(p.t().id(), p.s().id(), p.gap()));
    }
    return out;
  }
}
