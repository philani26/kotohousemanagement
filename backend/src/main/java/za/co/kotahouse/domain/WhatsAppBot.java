package za.co.kotahouse.domain;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * WhatsApp ordering bot: pure conversation logic (port of shared/whatsapp.ts).
 *   "3x2, 6"          → two of menu item 3 and one of item 6
 *   "note: no atchar" → kitchen note
 *   YES / CANCEL / MENU / STATUS
 */
public final class WhatsAppBot {
  private WhatsAppBot() {}

  public static final int MAX_ITEMS_PER_ORDER = 20;
  public static final int MAX_QTY_PER_LINE = 10;

  private static final Pattern YES = Pattern.compile("^(yes|y|yebo|ja|confirm|ok|okay)\\b", Pattern.CASE_INSENSITIVE);
  private static final Pattern CANCEL = Pattern.compile("^(cancel|stop order|no)\\b", Pattern.CASE_INSENSITIVE);
  private static final Pattern MENU = Pattern.compile("^(menu|hi|hello|hey|hallo|sawubona|molo|start|order)\\b", Pattern.CASE_INSENSITIVE);
  private static final Pattern STATUS = Pattern.compile("^(status|where|my order)\\b", Pattern.CASE_INSENSITIVE);
  private static final Pattern NOTE = Pattern.compile("^note\\s*[:\\-]?\\s*(.+)$", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);

  public record MenuItem(String productId, String name, long priceCents) {}

  public record DraftLine(String productId, String name, int quantity, long priceCents) {
    public Map<String, Object> toMap() {
      return Map.of("productId", productId, "name", name, "quantity", quantity, "priceCents", priceCents);
    }
  }

  public record ChatState(String step, List<DraftLine> draft, String note) {
    public static final ChatState EMPTY = new ChatState("idle", List.of(), "");

    @SuppressWarnings("unchecked")
    public static ChatState of(Map<String, Object> m) {
      if (m == null || m.isEmpty()) return EMPTY;
      List<DraftLine> draft = new ArrayList<>();
      for (Object o : m.get("draft") instanceof List<?> l ? l : List.of()) {
        Map<String, Object> d = (Map<String, Object>) o;
        draft.add(new DraftLine(Domain.str(d.get("productId")), Domain.str(d.get("name")), (int) Domain.cents(d.get("quantity")), Domain.cents(d.get("priceCents"))));
      }
      return new ChatState("confirming".equals(m.get("step")) ? "confirming" : "idle", draft, m.get("note") == null ? "" : m.get("note").toString());
    }

    public Map<String, Object> toMap() {
      return Map.of("step", step, "draft", draft.stream().map(DraftLine::toMap).toList(), "note", note);
    }
  }

  /** shop is trading now and a shift is open; lastOrder: the customer's latest order today, for STATUS */
  public record Context(String shopName, List<MenuItem> menu, boolean open, String openingText, String lastTicketNo, String lastStatus) {}

  /** placeOrder is set when the customer confirmed – the caller creates the order. */
  public record Result(List<String> replies, ChatState state, List<DraftLine> placeLines, String placeNote) {}

  public static String menuText(Context ctx) {
    List<String> lines = new ArrayList<>();
    lines.add("👋 Welcome to *" + ctx.shopName() + "*! Here's our menu:");
    lines.add("");
    for (int i = 0; i < ctx.menu().size(); i++) {
      MenuItem m = ctx.menu().get(i);
      lines.add((i + 1) + ". " + m.name() + " – " + Domain.formatZar(m.priceCents()));
    }
    lines.add("");
    lines.add("To order, reply with the item number and quantity, e.g. *3x2, 6* (two of item 3 and one of item 6).");
    lines.add("Add a note with *note: no atchar*. You pay when you collect.");
    return String.join("\n", lines);
  }

  public record Pick(int item, int quantity) {}

  /** Reads "3x2, 6, 1 x 3" into 1-based item numbers and quantities; null when the text is not an order. */
  public static List<Pick> parseOrderText(String text) {
    String cleaned = text.toLowerCase().replaceAll("[×*]", "x").trim();
    if (!cleaned.matches("^[\\d\\sx,;.+&and]+$") || !cleaned.matches("(?s).*\\d.*")) return null;
    List<Pick> out = new ArrayList<>();
    for (String raw : cleaned.split("[,;+&]|\\band\\b")) {
      String part = raw.trim();
      if (part.isEmpty()) continue;
      Matcher m = Pattern.compile("^(\\d{1,3})\\s*(?:x\\s*(\\d{1,2}))?$").matcher(part);
      if (!m.matches()) return null;
      out.add(new Pick(Integer.parseInt(m.group(1)), m.group(2) != null ? Integer.parseInt(m.group(2)) : 1));
    }
    return out.isEmpty() ? null : out;
  }

  public static long draftTotal(List<DraftLine> lines) {
    return lines.stream().mapToLong(l -> l.priceCents() * l.quantity()).sum();
  }

  public static String orderSummary(List<DraftLine> lines, String note) {
    List<String> out = new ArrayList<>();
    for (DraftLine l : lines) out.add("• " + l.quantity() + "× " + l.name() + " – " + Domain.formatZar(l.priceCents() * l.quantity()));
    if (!note.isEmpty()) out.add("📝 " + note);
    out.add("*Total: " + Domain.formatZar(draftTotal(lines)) + "* (pay at collection)");
    return String.join("\n", out);
  }

  /** One step of the conversation. */
  public static Result handleIncoming(String text, ChatState state, Context ctx) {
    String msg = text.trim();
    if (STATUS.matcher(msg).find()) {
      return keep(state, ctx.lastTicketNo() != null
          ? "Your order #" + ctx.lastTicketNo() + " is *" + statusLabel(ctx.lastStatus()) + "*."
          : "You don't have an order today. Reply *menu* to order.");
    }
    if (!ctx.open()) return new Result(List.of("Sorry, *" + ctx.shopName() + "* is closed right now. " + ctx.openingText()), ChatState.EMPTY, null, null);
    if (CANCEL.matcher(msg).find()) return new Result(List.of("Order cancelled. Reply *menu* whenever you want to order."), ChatState.EMPTY, null, null);

    Matcher note = NOTE.matcher(msg);
    if (note.matches()) {
      String n = note.group(1).trim();
      ChatState next = new ChatState(state.step(), state.draft(), n.length() > 200 ? n.substring(0, 200) : n);
      return new Result(List.of(next.draft().isEmpty()
          ? "Note saved. Now send your order, e.g. *3x2, 6*."
          : "Note added.\n\n" + orderSummary(next.draft(), next.note()) + "\n\nReply *YES* to place the order."), next, null, null);
    }
    if (YES.matcher(msg).find()) {
      if (!"confirming".equals(state.step()) || state.draft().isEmpty()) {
        return keep(state, "There's nothing to confirm yet. Send your order, e.g. *3x2, 6*, or *menu* to see the menu.");
      }
      return new Result(List.of(), ChatState.EMPTY, state.draft(), state.note());
    }
    List<Pick> parsed = parseOrderText(msg);
    if (parsed != null) {
      Map<String, DraftLine> merged = new LinkedHashMap<>();
      for (Pick p : parsed) {
        if (p.item() < 1 || p.item() > ctx.menu().size()) return keep(state, "There's no item " + p.item() + " on the menu. Reply *menu* to see the numbers.");
        if (p.quantity() < 1 || p.quantity() > MAX_QTY_PER_LINE) return keep(state, "Please order between 1 and " + MAX_QTY_PER_LINE + " of each item.");
        MenuItem m = ctx.menu().get(p.item() - 1);
        DraftLine before = merged.get(m.productId());
        merged.put(m.productId(), new DraftLine(m.productId(), m.name(), (before == null ? 0 : before.quantity()) + p.quantity(), m.priceCents()));
      }
      List<DraftLine> draft = List.copyOf(merged.values());
      if (draft.stream().mapToInt(DraftLine::quantity).sum() > MAX_ITEMS_PER_ORDER) {
        return keep(state, "That's a big order! For more than " + MAX_ITEMS_PER_ORDER + " items please call the shop.");
      }
      return new Result(List.of("Here's your order:\n\n" + orderSummary(draft, state.note()) + "\n\nReply *YES* to place it, or send a new list to change it."),
          new ChatState("confirming", draft, state.note()), null, null);
    }
    // anything else (including "hi" / "menu"): show the menu
    if (MENU.matcher(msg).find() || "idle".equals(state.step())) return keep(state, menuText(ctx));
    return keep(state, "Sorry, I didn't get that. Send your order like *3x2, 6*, reply *YES* to confirm, or *menu* to start again.");
  }

  private static Result keep(ChatState state, String reply) {
    return new Result(List.of(reply), state, null, null);
  }

  public static String statusLabel(String status) {
    return switch (status == null ? "" : status) {
      case "new" -> "received";
      case "preparing" -> "being prepared";
      case "ready" -> "ready to collect";
      case "collected" -> "collected";
      default -> status;
    };
  }

  /** Messages sent to the customer when staff move the ticket along. */
  public static String statusMessage(String status, Object ticketNo, String shopName, long totalCents, boolean paid) {
    return switch (status) {
      case "preparing" -> "👨‍🍳 Your order #" + ticketNo + " is being prepared.";
      case "ready" -> "✅ Your order #" + ticketNo + " is *ready to collect* at " + shopName + "!"
          + (paid ? "" : " Please pay " + Domain.formatZar(totalCents) + " when you collect (cash or card).");
      case "collected" -> "Thank you for buying at " + shopName + "! Enjoy your meal 🙏";
      default -> null;
    };
  }

  /** 27821234567 → +27 82 123 4567 */
  public static String displayPhone(String waId) {
    String d = waId.replaceAll("\\D", "");
    return d.matches("^27\\d{9}$") ? "+27 " + d.substring(2, 4) + " " + d.substring(4, 7) + " " + d.substring(7) : "+" + d;
  }
}
