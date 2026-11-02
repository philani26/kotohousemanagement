package za.co.kotahouse.shop;

/** The signed-in person acting in one shop, with their role there. */
public record Caller(String uid, String businessId, String role, String name) {
  public boolean isOwner() {
    return "owner".equals(role);
  }
}
