package za.co.kotahouse.store;

import java.util.ArrayList;
import java.util.List;

/** A list query over one collection: the same operations the app used on Firestore. */
public record Query(String collection, List<Filter> filters, List<Order> orders, Integer limit) {

  public enum Operator {
    EQ("="), LT("<"), LTE("<="), GT(">"), GTE(">="), IN("in"), NE("<>");

    final String sql;

    Operator(String sql) {
      this.sql = sql;
    }

    public static Operator parse(String s) {
      return switch (s) {
        case "==" -> EQ;
        case "<" -> LT;
        case "<=" -> LTE;
        case ">" -> GT;
        case ">=" -> GTE;
        case "in" -> IN;
        case "!=" -> NE;
        default -> throw new IllegalArgumentException("Unsupported operator " + s);
      };
    }
  }

  public record Filter(String field, Operator op, Object value) {}

  public record Order(String field, boolean desc) {}

  public static Builder of(String collection) {
    return new Builder(collection);
  }

  public static final class Builder {
    private final String collection;
    private final List<Filter> filters = new ArrayList<>();
    private final List<Order> orders = new ArrayList<>();
    private Integer limit;

    Builder(String collection) {
      this.collection = collection;
    }

    public Builder where(String field, String op, Object value) {
      filters.add(new Filter(field, Operator.parse(op), value));
      return this;
    }

    public Builder orderBy(String field, boolean desc) {
      orders.add(new Order(field, desc));
      return this;
    }

    public Builder limit(int n) {
      limit = n;
      return this;
    }

    public Query build() {
      return new Query(collection, List.copyOf(filters), List.copyOf(orders), limit);
    }
  }
}
