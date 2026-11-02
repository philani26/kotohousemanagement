package za.co.kotahouse.store;

/** Field operations for {@link Store#update} / {@link Store#merge}, like Firestore's FieldValue. */
public sealed interface Op {
  /** adds to a number (missing counts as 0) */
  record Inc(double by) implements Op {}

  /** the commit time */
  record ServerTime() implements Op {}

  /** removes the field */
  record Delete() implements Op {}

  static Inc inc(double by) {
    return new Inc(by);
  }

  static ServerTime serverTime() {
    return new ServerTime();
  }

  static Delete delete() {
    return new Delete();
  }
}
