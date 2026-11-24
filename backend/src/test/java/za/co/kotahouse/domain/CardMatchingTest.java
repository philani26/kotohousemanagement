package za.co.kotahouse.domain;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import org.junit.jupiter.api.Test;
import za.co.kotahouse.domain.CardMatching.Match;
import za.co.kotahouse.domain.CardMatching.Sale;
import za.co.kotahouse.domain.CardMatching.Txn;

class CardMatchingTest {
  private static final long MIN = 60_000;
  private static final long W = CardMatching.DEFAULT_WINDOW_MS;

  @Test
  void matchesSameAmountWithinTheWindowClosestFirst() {
    var txns = List.of(new Txn("t1", 10 * MIN, 3500, true));
    var sales = List.of(new Sale("far", 0, 3500), new Sale("near", 9 * MIN, 3500), new Sale("other", 10 * MIN, 4000));
    assertThat(CardMatching.match(txns, sales, W)).containsExactly(new Match("t1", "near", MIN));
  }

  @Test
  void eachPaymentAndSaleIsUsedOnce() {
    // two R35 kotas a minute apart, two R35 payments: one each, never both to one sale
    var txns = List.of(new Txn("t1", 0, 3500, true), new Txn("t2", MIN, 3500, true));
    var sales = List.of(new Sale("s1", 0, 3500), new Sale("s2", MIN, 3500));
    assertThat(CardMatching.match(txns, sales, W)).containsExactlyInAnyOrder(new Match("t1", "s1", 0), new Match("t2", "s2", 0));
  }

  @Test
  void outsideTheWindowDeclinedOrDifferentAmountsDontMatch() {
    var sales = List.of(new Sale("s1", 0, 3500));
    assertThat(CardMatching.match(List.of(new Txn("late", 16 * MIN, 3500, true)), sales, W)).isEmpty();
    assertThat(CardMatching.match(List.of(new Txn("declined", 0, 3500, false)), sales, W)).isEmpty();
    assertThat(CardMatching.match(List.of(new Txn("cents", 0, 3499, true)), sales, W)).isEmpty();
    assertThat(CardMatching.match(List.of(new Txn("refund", 0, -3500, true)), sales, W)).isEmpty();
  }

  @Test
  void theResultDoesNotDependOnOrder() {
    var a = List.of(new Txn("t1", 0, 3500, true), new Txn("t2", 2 * MIN, 3500, true));
    var b = List.of(new Txn("t2", 2 * MIN, 3500, true), new Txn("t1", 0, 3500, true));
    var sales = List.of(new Sale("s1", MIN, 3500));
    assertThat(CardMatching.match(a, sales, W)).isEqualTo(CardMatching.match(b, sales, W));
    assertThat(CardMatching.match(a, sales, W)).containsExactly(new Match("t1", "s1", MIN));
  }
}
